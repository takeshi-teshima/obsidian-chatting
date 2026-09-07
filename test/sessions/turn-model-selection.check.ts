import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeApp } from "./fake-app";
import { ObsidianSessionStorageAdapter } from "../../src/sessions/obsidian-storage-adapter";
import { SessionMetadataStore } from "../../src/sessions/metadata/store";
import { ChattingHistoryStore } from "../../src/sessions/history/store";
import { SessionIndexStore } from "../../src/sessions/index/store";
import { SessionLocalStateStore } from "../../src/sessions/local/store";
import { SessionWorkspaceStore } from "../../src/sessions/store";
import { SessionManager } from "../../src/sessions/runtime/manager";
import type { SessionAgentAdapter, SessionAgentCallbacks } from "../../src/sessions/runtime/runtime";
import type { SessionRunRequest } from "../../src/sessions/runtime/types";
import type { TurnExecutionConfig } from "../../src/turn-execution/types";
import type { UnifiedMessage } from "../../src/types";
import { stampLatestCanonicalUserMessage } from "../../src/turn-execution/provenance";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok - ${name}`);
    })
    .catch((error) => {
      console.error(`  FAIL - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

/**
 * Deterministic poll instead of a fixed sleep(): waits for `predicate` to
 * become true, checking every 5ms up to `timeoutMs`. Fixed sleeps here would
 * be flaky under real fs I/O (ObsidianSessionStorageAdapter does real reads/
 * writes) and under concurrent test-file scheduling in test/sessions/run.mjs.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Fake AgentLoop-shaped adapter that records the admitted TurnExecutionConfig
 * for every run() call and stamps provenance the way the real
 * AgentLoopSessionAdapter does, using the real production stamping function
 * (not a reimplementation) so the persisted-JSONL assertions below exercise
 * actual product code, not test-only logic.
 */
class FakeAgent implements SessionAgentAdapter {
  private messages: UnifiedMessage[] = [];
  public runs: TurnExecutionConfig[] = [];
  private resolvers: Array<() => void> = [];
  private aborted = false;

  importMessages(messages: UnifiedMessage[]): void { this.messages = structuredClone(messages); }
  exportMessages(): UnifiedMessage[] { return structuredClone(this.messages); }
  resetProviderContinuation(): void { /* no-op fake */ }
  abort(): void { this.aborted = true; this.resolvers.shift()?.(); }

  async run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void> {
    this.messages.push({ role: "user", content: request.text });
    stampLatestCanonicalUserMessage(this.messages, request.execution);
    // Record AFTER stamping/pushing so `waitUntil(() => runs.length >= N)`
    // callers can safely export messages immediately once this observably ticks up.
    this.runs.push(structuredClone(request.execution));
    callbacks.onThinking();
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
    if (!this.aborted) {
      this.messages.push({ role: "assistant", content: "done" });
      callbacks.onResponse("done");
    }
    this.aborted = false;
  }

  resolveNext(): void {
    this.resolvers.shift()?.();
  }
}

async function mkStore(): Promise<SessionWorkspaceStore> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-turn-model-"));
  const app = createFakeApp(vault);
  const adapter = new ObsidianSessionStorageAdapter(app);
  const store = new SessionWorkspaceStore(
    new SessionMetadataStore(adapter),
    new ChattingHistoryStore(adapter),
    new SessionLocalStateStore(adapter),
    new SessionIndexStore(adapter),
  );
  await store.initialize();
  return store;
}

async function main(): Promise<void> {
  console.log("== SEMANTICS.md scenario: turn admission freezes model/reasoning per turn ==");

  const store = await mkStore();
  const agents = new Map<string, FakeAgent>();
  const manager = new SessionManager({
    store,
    agentFactory: {
      create: (metadata) => {
        const agent = new FakeAgent();
        agents.set(metadata.id, agent);
        return agent;
      },
    },
    getDefaultSessionSeed: () => ({ title: "New chat" }),
    getTurnSelectionFallback: () => ({ provider: "chatgpt-oauth", model: "gpt-5.6-terra", reasoningEffort: "medium" }),
    // Force B to queue behind A on the GLOBAL concurrency cap (cross-session
    // queueing — same-session concurrent turns remain forbidden throughout;
    // see runtime.ts's `if (this.phase !== "idle" ...) throw`).
    maxConcurrentRuns: 1,
    maxHydratedRuntimes: 8,
  });

  const a = (await manager.createSession({
    title: "A", selectedModel: "gpt-5.6-terra", upstreamProvider: "chatgpt-oauth", reasoningEffort: "medium",
  })).metadata.id;
  const b = (await manager.createSession({
    title: "B", selectedModel: "gpt-5.6-sol", upstreamProvider: "chatgpt-oauth", reasoningEffort: "high",
  })).metadata.id;

  let runA1: Promise<void>;
  await check("A1 is admitted with Model X (Terra) / Medium effort", async () => {
    runA1 = manager.run(a, { text: "A1" });
    await waitUntil(() => (agents.get(a)?.runs.length ?? 0) >= 1);
    assert.equal(agents.get(a)?.runs[0]?.model, "gpt-5.6-terra");
    assert.equal(agents.get(a)?.runs[0]?.reasoningEffort, "medium");
  });

  await check("changing A's selector to Model Y/High while A1 is still running does not affect A1", async () => {
    await manager.setNextTurnSelection(a, { provider: "chatgpt-oauth", model: "gpt-5.6-sol", reasoningEffort: "high" });
    assert.equal(agents.get(a)?.runs[0]?.model, "gpt-5.6-terra", "A1's admitted config must not change mid-run");
    assert.equal(agents.get(a)?.runs[0]?.reasoningEffort, "medium");
  });

  let runB: Promise<void>;
  await check("B1 is globally queued (maxConcurrentRuns=1) with its own Sol/High snapshot captured at Send", async () => {
    runB = manager.run(b, { text: "B1" });
    await waitUntil(() => manager.getRuntimePhase(b) === "queued");
    // Change B's selector AFTER Send but BEFORE B1 is actually admitted from the queue.
    await manager.setNextTurnSelection(b, { provider: "chatgpt-oauth", model: "gpt-5.6-luna", reasoningEffort: "low" });
  });

  await check("finishing A1 lets B1 start, using the snapshot captured at ITS Send (Sol/High), not the later Luna/Low change", async () => {
    agents.get(a)?.resolveNext();
    await waitUntil(() => (agents.get(b)?.runs.length ?? 0) >= 1);
    assert.equal(agents.get(b)?.runs[0]?.model, "gpt-5.6-sol");
    assert.equal(agents.get(b)?.runs[0]?.reasoningEffort, "high");
    await runA1!;
  });

  let runA2: Promise<void>;
  await check("A2 (sent after the mid-run selector change) uses the NEW Model Y/High selection", async () => {
    agents.get(b)?.resolveNext();
    await runB!;
    runA2 = manager.run(a, { text: "A2" });
    await waitUntil(() => (agents.get(a)?.runs.length ?? 0) >= 2);
    assert.equal(agents.get(a)?.runs[1]?.model, "gpt-5.6-sol");
    assert.equal(agents.get(a)?.runs[1]?.reasoningEffort, "high");
    agents.get(a)?.resolveNext();
    await runA2!;
  });

  await check("SessionMetadata.selectedModel always represents the next-turn model (persisted)", async () => {
    const loaded = await store.load(a);
    assert.equal(loaded?.metadata.selectedModel, "gpt-5.6-sol");
  });

  await check("persisted JSONL provenance: A1's canonical user message is stamped Terra/Medium, A2's is stamped Sol/High", async () => {
    const loaded = await store.load(a);
    const userMessages = (loaded?.messages ?? []).filter(
      (m): m is UnifiedMessage & { execution: NonNullable<UnifiedMessage["execution"]> } =>
        m.role === "user" && typeof m.content === "string" && !!m.execution,
    );
    assert.equal(userMessages.length, 2, "expected exactly 2 stamped canonical user messages (A1, A2)");
    assert.equal(userMessages[0].execution.model, "gpt-5.6-terra");
    assert.equal(userMessages[0].execution.reasoningEffort, "medium");
    assert.equal(userMessages[1].execution.model, "gpt-5.6-sol");
    assert.equal(userMessages[1].execution.reasoningEffort, "high");
    console.log(`  before/after provenance: A1=${userMessages[0].execution.model}/${userMessages[0].execution.reasoningEffort} -> A2=${userMessages[1].execution.model}/${userMessages[1].execution.reasoningEffort}`);
  });

  await check("persisted JSONL provenance: B1's canonical user message is stamped Sol/High (its own admission snapshot, not Luna/Low)", async () => {
    const loaded = await store.load(b);
    const userMessages = (loaded?.messages ?? []).filter(
      (m): m is UnifiedMessage & { execution: NonNullable<UnifiedMessage["execution"]> } =>
        m.role === "user" && typeof m.content === "string" && !!m.execution,
    );
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0].execution.model, "gpt-5.6-sol");
    assert.equal(userMessages[0].execution.reasoningEffort, "high");
  });

  console.log(`\n${passed} checks passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
