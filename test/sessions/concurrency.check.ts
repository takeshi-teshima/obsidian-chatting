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
import type { UnifiedMessage } from "../../src/types";

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
 * Fake AgentLoop-shaped adapter: runs for `delayMs`, appending a fake
 * exchange to its in-memory messages, unless aborted first (in which case it
 * resolves early having appended nothing further). Used to validate
 * SessionManager/SessionRuntime concurrency + stop semantics WITHOUT any real
 * network calls (no API key needed in this environment).
 */
class FakeAgentAdapter implements SessionAgentAdapter {
  private messages: UnifiedMessage[] = [];
  private aborted = false;
  private abortSignal: (() => void) | null = null;
  public runCount = 0;

  constructor(private readonly delayMs: number) {}

  async run(request: { text: string }, callbacks: SessionAgentCallbacks): Promise<void> {
    this.runCount++;
    this.messages.push({ role: "user", content: request.text });
    callbacks.onThinking();
    // Interruptible sleep, mirroring a real AgentLoop's abort() actually
    // tearing down its in-flight fetch/stream promptly rather than idling
    // out a fixed timer.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.delayMs);
      this.abortSignal = () => { clearTimeout(timer); resolve(); };
    });
    this.abortSignal = null;
    if (this.aborted) return;
    callbacks.onResponse(`echo: ${request.text}`);
    this.messages.push({ role: "assistant", content: [{ type: "text", text: `echo: ${request.text}` }] });
  }
  abort(): void { this.aborted = true; this.abortSignal?.(); }
  exportMessages(): UnifiedMessage[] { return this.messages; }
  importMessages(messages: UnifiedMessage[]): void { this.messages = messages; this.aborted = false; }
  resetProviderContinuation(): void { /* no-op fake */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mkStore(): Promise<{ store: SessionWorkspaceStore; vault: string }> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-concurrency-"));
  const app = createFakeApp(vault);
  const adapter = new ObsidianSessionStorageAdapter(app);
  const store = new SessionWorkspaceStore(
    new SessionMetadataStore(adapter),
    new ChattingHistoryStore(adapter),
    new SessionLocalStateStore(adapter),
    new SessionIndexStore(adapter),
  );
  await store.initialize();
  return { store, vault };
}

async function main() {
  console.log("== concurrency: two sessions run independently ==");
  const { store } = await mkStore();
  const agents = new Map<string, FakeAgentAdapter>();
  const manager = new SessionManager({
    store,
    agentFactory: {
      create: (metadata) => {
        const agent = new FakeAgentAdapter(150);
        agents.set(metadata.id, agent);
        return agent;
      },
    },
    getDefaultSessionSeed: () => ({ title: "New chat" }),
    maxConcurrentRuns: 3,
    maxHydratedRuntimes: 8,
  });

  const a = await manager.createSession();
  const b = await manager.createSession();

  await check("session A starts running", async () => {
    const runA = manager.run(a.metadata.id, { text: "hello A" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(a.metadata.id), "running");
    await runA;
    assert.equal(manager.getRuntimePhase(a.metadata.id), "idle");
  });

  console.log("\n== switch to B mid-run of A, both proceed concurrently ==");
  await check("A and B run concurrently without blocking each other", async () => {
    const runA = manager.run(a.metadata.id, { text: "second turn A" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(a.metadata.id), "running");
    const runB = manager.run(b.metadata.id, { text: "first turn B" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(a.metadata.id), "running", "A should still be running");
    assert.equal(manager.getRuntimePhase(b.metadata.id), "running", "B should be running concurrently with A");
    await Promise.all([runA, runB]);
    assert.equal(manager.getRuntimePhase(a.metadata.id), "idle");
    assert.equal(manager.getRuntimePhase(b.metadata.id), "idle");
  });

  console.log("\n== same-session serialization: two turns on the same session never overlap ==");
  await check("second run() on a busy session is rejected, not silently interleaved", async () => {
    const runA = manager.run(a.metadata.id, { text: "third turn A" });
    await sleep(10);
    await assert.rejects(() => manager.run(a.metadata.id, { text: "overlapping turn A" }), /already running/);
    await runA;
  });

  console.log("\n== stop A does not affect concurrently-running B ==");
  await check("stopping A while B runs leaves B unaffected; A cleanly stops", async () => {
    agents.get(b.metadata.id)!; // ensure B's runtime is already hydrated from the prior check
    const runA = manager.run(a.metadata.id, { text: "fourth turn A (will be stopped)" });
    const runB = manager.run(b.metadata.id, { text: "second turn B" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(a.metadata.id), "running");
    assert.equal(manager.getRuntimePhase(b.metadata.id), "running");
    await manager.stop(a.metadata.id);
    await runA;
    assert.equal(manager.getRuntimePhase(a.metadata.id), "idle");
    assert.equal(manager.getRuntimePhase(b.metadata.id), "running", "B must still be running after A was stopped");
    await runB;
    assert.equal(manager.getRuntimePhase(b.metadata.id), "idle");
  });

  console.log("\n== switching back to A shows stopped, not stale 'running' ==");
  await check("A's snapshot reflects idle after being stopped, not a stale running phase", async () => {
    const viewId = "test-view-a";
    const snapshot = await manager.bindView(viewId, a.metadata.id);
    assert.equal(snapshot.phase, "idle");
    manager.unbindView(viewId);
  });

  console.log("\n== reload-from-disk under concurrency: reloading A never touches B's live runtime ==");
  await check("reloading A's history from disk leaves B's in-memory messages untouched", async () => {
    const runB = manager.run(b.metadata.id, { text: "third turn B (in flight during A's reload)" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(b.metadata.id), "running");

    const beforeReload = agents.get(b.metadata.id)!.exportMessages().length;
    const reloaded = await manager.reloadFromDisk(a.metadata.id);
    assert.ok(reloaded.messages.length >= 0);

    // B's live runtime must be completely unaffected by A's reload.
    assert.equal(manager.getRuntimePhase(b.metadata.id), "running", "B's runtime must still be running");
    assert.equal(agents.get(b.metadata.id)!.exportMessages().length, beforeReload, "B's in-memory messages must be unchanged by A's reload");
    await runB;
    assert.equal(manager.getRuntimePhase(b.metadata.id), "idle");
  });

  console.log("\n== stress: many sessions completing turns concurrently never corrupts the shared index ==");
  await check("20 sessions x 3 turns each, all interleaved, index ends up consistent", async () => {
    const stressSessions = await Promise.all(
      Array.from({ length: 20 }, () => manager.createSession()),
    );
    // Turns within one session are sequential (same-session concurrency is
    // forbidden by design); the 20 sessions' sequences run concurrently with
    // each other, which is exactly the scenario that raced the shared index.
    await Promise.all(
      stressSessions.map(async (s) => {
        for (let turn = 0; turn < 3; turn++) {
          await manager.run(s.metadata.id, { text: `stress turn ${turn}` });
        }
      }),
    );
    for (const s of stressSessions) {
      assert.equal(manager.getRuntimePhase(s.metadata.id), "idle");
    }
    const stats = await manager.getStats();
    // a + b + 20 stress sessions, none archived.
    assert.equal(stats.activeCount, 2 + 20);
  });

  await manager.shutdown();
  console.log(`\n${passed} checks passed.`);
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
