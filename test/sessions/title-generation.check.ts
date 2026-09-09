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
import type { SessionMetadata } from "../../src/sessions/metadata/types";
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
 * Deterministic poll instead of a fixed sleep(): title generation is
 * deliberately fire-and-forget (never awaited by run()), so tests must poll
 * for the async side effect to land rather than assume any fixed timing.
 */
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fake AgentLoop-shaped adapter: on run(), appends the user message + (after
 * `delayMs`) a fixed assistant reply, exercising the SAME mid-turn
 * checkpoint path (`onResponse` -> `SessionRuntime.checkpointMessages()` ->
 * `SessionWorkspaceStore.saveHistoryAndActivity()`) that applies the
 * existing crude "first message, truncated" heuristic title BEFORE this
 * turn's run() call resolves. This is deliberate — it is exactly the race
 * that makes SessionManager capture title-generation eligibility PRE-turn
 * (see manager.ts's `titleGenerationEligible` map doc comment), and this
 * live simulation is what actually proves that decision matters instead of
 * just asserting it at the type level.
 */
class FakeAgentAdapter implements SessionAgentAdapter {
  private messages: UnifiedMessage[] = [];
  private aborted = false;

  constructor(private readonly delayMs: number = 5) {}

  async run(request: { text: string }, callbacks: SessionAgentCallbacks): Promise<void> {
    this.messages.push({ role: "user", content: request.text });
    callbacks.onThinking();
    await sleep(this.delayMs);
    if (this.aborted) return;
    callbacks.onResponse(`echo: ${request.text}`);
    this.messages.push({ role: "assistant", content: [{ type: "text", text: `echo: ${request.text}` }] });
  }
  abort(): void { this.aborted = true; }
  exportMessages(): UnifiedMessage[] { return this.messages; }
  importMessages(messages: UnifiedMessage[]): void { this.messages = messages; this.aborted = false; }
  resetProviderContinuation(): void { /* no-op fake */ }
}

async function mkStore(): Promise<SessionWorkspaceStore> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-title-gen-"));
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

interface GenerateTitleCall {
  sessionId: string;
  metadata: SessionMetadata;
  conversationText: string;
}

async function main(): Promise<void> {
  console.log("== title generation: pristine session state before any turn ==");
  {
    const store = await mkStore();
    const calls: GenerateTitleCall[] = [];
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async (input) => { calls.push(input); return "Generated Title"; },
    });

    const session = await manager.createSession();
    await check("a pristine session's title is 'New chat' and titleGenerationStatus is unset", async () => {
      assert.equal(session.metadata.title, "New chat");
      assert.equal(session.metadata.titleGenerationStatus, undefined);
      const meta = await store.getMeta(session.metadata.id);
      assert.equal(meta?.title, "New chat");
      assert.equal(meta?.titleGenerationStatus, undefined);
    });

    await manager.shutdown();
  }

  console.log("\n== title generation: fires exactly once after the first successful turn ==");
  {
    const store = await mkStore();
    const calls: GenerateTitleCall[] = [];
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async (input) => {
        calls.push(input);
        return `  "A Generated Title"  `;
      },
    });

    const session = await manager.createSession();
    const id = session.metadata.id;

    await check("first turn completes; generateTitle is called exactly once with pending -> success transition, and the persisted title reflects the sanitized result", async () => {
      await manager.run(id, { text: "hello there" });
      await waitUntil(async () => (await store.getMeta(id))?.titleGenerationStatus === "success");

      assert.equal(calls.length, 1, "generateTitle must be called exactly once");
      assert.equal(calls[0]!.sessionId, id);
      assert.match(calls[0]!.conversationText, /User: hello there/);
      assert.match(calls[0]!.conversationText, /Assistant: echo: hello there/);

      const meta = await store.getMeta(id);
      assert.equal(meta?.titleGenerationStatus, "success");
      // Trimmed and surrounding-quote-stripped.
      assert.equal(meta?.title, "A Generated Title");
    });

    console.log("\n== title generation: a second turn on the SAME session does not re-trigger it ==");
    await check("second turn does not call generateTitle again (title is no longer 'New chat')", async () => {
      await manager.run(id, { text: "second message" });
      await sleep(50); // give any (incorrect) fire-and-forget call a chance to land
      assert.equal(calls.length, 1, "generateTitle must still have been called exactly once");
      const meta = await store.getMeta(id);
      assert.equal(meta?.title, "A Generated Title", "title must be unaffected by the second turn");
    });

    await manager.shutdown();
  }

  console.log("\n== title generation: failure path never surfaces as a turn error ==");
  {
    const store = await mkStore();
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async () => { throw new Error("simulated provider failure"); },
    });

    const session = await manager.createSession();
    const id = session.metadata.id;

    await check("generateTitle throwing ends in titleGenerationStatus 'failed', title stays 'New chat', and the turn itself still reports success", async () => {
      // run() resolving at all (not rejecting) is itself part of the
      // assertion: a title-generation failure must never propagate out of
      // run() to its caller.
      await manager.run(id, { text: "hello" });
      assert.equal(manager.getRuntimePhase(id), "idle");

      await waitUntil(async () => (await store.getMeta(id))?.titleGenerationStatus === "failed");
      const meta = await store.getMeta(id);
      assert.equal(meta?.titleGenerationStatus, "failed");
      assert.equal(meta?.title, "New chat", "title must remain the untouched default on failure");
    });

    await manager.shutdown();
  }

  console.log("\n== regenerateTitle: explicit command path forces a re-run even when a title already exists ==");
  {
    const store = await mkStore();
    let callCount = 0;
    let nextTitle = "First Generated Title";
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async () => { callCount++; return nextTitle; },
    });

    const session = await manager.createSession();
    const id = session.metadata.id;

    await check("first turn generates a title normally", async () => {
      await manager.run(id, { text: "hello" });
      await waitUntil(async () => (await store.getMeta(id))?.titleGenerationStatus === "success");
      assert.equal(callCount, 1);
      const meta = await store.getMeta(id);
      assert.equal(meta?.title, "First Generated Title");
    });

    await check("regenerateTitle() calls generateTitle again and overwrites the existing title", async () => {
      nextTitle = "Second Generated Title";
      await manager.regenerateTitle(id);
      await waitUntil(async () => (await store.getMeta(id))?.title === "Second Generated Title");
      assert.equal(callCount, 2, "regenerateTitle must invoke generateTitle again despite an existing real title");
      const meta = await store.getMeta(id);
      assert.equal(meta?.title, "Second Generated Title");
      assert.equal(meta?.titleGenerationStatus, "success");
    });

    await manager.shutdown();
  }

  console.log("\n== regression: regenerateTitle() reflects the WHOLE conversation, not just the first exchange ==");
  {
    // A real user report: regenerating a title well into a long conversation
    // still only produced a title based on message #1, because the digest
    // builder used to hard-search for the FIRST user/assistant message
    // specifically, no matter how many turns had happened since.
    const store = await mkStore();
    let lastConversationText = "";
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async ({ conversationText }) => {
        lastConversationText = conversationText;
        return "A Title";
      },
    });

    const session = await manager.createSession();
    const id = session.metadata.id;

    await manager.run(id, { text: "let's talk about sourdough bread" });
    await waitUntil(async () => (await store.getMeta(id))?.titleGenerationStatus === "success");
    await manager.run(id, { text: "actually, let's switch to talking about pasta instead" });
    await sleep(20); // second turn must NOT re-trigger automatic generation; give it a moment to (not) happen

    await check("regenerateTitle()'s digest includes topics from turns AFTER the first one", async () => {
      lastConversationText = "";
      await manager.regenerateTitle(id);
      await waitUntil(() => lastConversationText !== "");
      assert.match(lastConversationText, /sourdough bread/, "must still include the opening topic");
      assert.match(
        lastConversationText,
        /pasta instead/,
        "must include the SECOND turn's topic too -- this is exactly what was missing before the fix"
      );
    });

    await manager.shutdown();
  }

  console.log("\n== title generation disabled via the live isTitleGenerationEnabled gate: automatic trigger skips, but regenerateTitle still works ==");
  {
    const store = await mkStore();
    let enabled = false;
    let callCount = 0;
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter() },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      isTitleGenerationEnabled: () => enabled,
      generateTitle: async () => { callCount++; return "Should Not Appear Automatically"; },
    });

    const session = await manager.createSession();
    const id = session.metadata.id;

    await check("automatic trigger is skipped while disabled", async () => {
      await manager.run(id, { text: "hello" });
      await sleep(50);
      assert.equal(callCount, 0, "generateTitle must not be called while the live gate reports disabled");
      const meta = await store.getMeta(id);
      assert.notEqual(meta?.titleGenerationStatus, "success");
    });

    await check("explicit regenerateTitle() bypasses the enabled gate", async () => {
      await manager.regenerateTitle(id);
      await waitUntil(async () => (await store.getMeta(id))?.titleGenerationStatus === "success");
      assert.equal(callCount, 1);
    });

    await manager.shutdown();
  }

  console.log("\n== concurrency: two sessions completing their first turns concurrently each get their own correct title ==");
  {
    const store = await mkStore();
    const manager = new SessionManager({
      store,
      agentFactory: { create: () => new FakeAgentAdapter(30) },
      getDefaultSessionSeed: () => ({ title: "New chat" }),
      getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      generateTitle: async ({ sessionId, conversationText }) => `Title for ${sessionId} (${conversationText})`,
    });

    const a = await manager.createSession();
    const b = await manager.createSession();

    await check("A and B each resolve to their own generated title with no cross-contamination", async () => {
      await Promise.all([
        manager.run(a.metadata.id, { text: "first turn A" }),
        manager.run(b.metadata.id, { text: "first turn B" }),
      ]);

      await waitUntil(async () => {
        const [metaA, metaB] = await Promise.all([store.getMeta(a.metadata.id), store.getMeta(b.metadata.id)]);
        return metaA?.titleGenerationStatus === "success" && metaB?.titleGenerationStatus === "success";
      });

      // Titles are capped to 60 chars by sanitizeGeneratedTitle(), so assert
      // each starts with its own sessionId (proving no cross-contamination
      // between A's and B's concurrently-running title generation) rather
      // than an exact match on the full (longer, truncated) string.
      const [metaA, metaB] = await Promise.all([store.getMeta(a.metadata.id), store.getMeta(b.metadata.id)]);
      assert.ok(metaA?.title?.startsWith(`Title for ${a.metadata.id}`), metaA?.title);
      assert.ok(metaB?.title?.startsWith(`Title for ${b.metadata.id}`), metaB?.title);
      assert.notEqual(metaA?.title, metaB?.title);
    });

    await manager.shutdown();
  }

  console.log(`\n${passed} checks passed.`);
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
