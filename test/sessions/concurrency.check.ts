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
  const { store, vault } = await mkStore();
  const agents = new Map<string, FakeAgentAdapter>();
  const autoReloadEvents: Array<{ sessionId: string; result: { changed: boolean } | { error: unknown } }> = [];
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
    getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    maxConcurrentRuns: 3,
    maxHydratedRuntimes: 8,
    onAutoReload: (sessionId, result) => autoReloadEvents.push({ sessionId, result }),
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

  console.log("\n== automatic reload-on-open: idle already-hydrated session picks up a hand-edited disk trim ==");
  await check("switching back to an idle, already-hydrated session reflects a hand-trimmed .jsonl (replaces the old manual Reload button)", async () => {
    const c = await manager.createSession();
    await manager.run(c.metadata.id, { text: "turn 1" });
    await manager.run(c.metadata.id, { text: "turn 2" });

    // c's runtime is already hydrated at this point (manager.run() hydrates
    // it internally), so this very first bindView() for c already exercises
    // ensureRuntimeForOpen's "already hydrated, idle -> reload" branch. Since
    // nothing has changed on disk since the last checkpoint, this reload is a
    // harmless no-op reporting changed:false.
    const firstViewId = "test-view-reload-c-1";
    const firstSnapshot = await manager.bindView(firstViewId, c.metadata.id);
    const beforeCount = firstSnapshot.messages.length;
    assert.ok(beforeCount >= 4, "sanity: two turns of a user+assistant fake agent should persist >= 4 messages");
    const eventsAfterFirstBind = autoReloadEvents.filter((e) => e.sessionId === c.metadata.id);
    assert.equal(eventsAfterFirstBind.length, 1, "the already-hydrated session's first bindView should still trigger exactly one auto-reload attempt");
    assert.deepEqual(eventsAfterFirstBind[0]!.result, { changed: false }, "no disk edit has happened yet, so this reload must report changed:false");

    // Hand-edit the canonical .jsonl on disk directly (bypassing the manager
    // entirely), simulating an external trim of the transcript.
    const jsonlPath = path.join(vault, ".chatting", "sessions", `${c.metadata.id}.jsonl`);
    const raw = await fs.readFile(jsonlPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length > 1, "sanity: need at least 2 lines to trim one and still have content");
    await fs.writeFile(jsonlPath, lines.slice(0, -1).join("\n") + "\n", "utf8");

    // Re-"open" the same session (simulating the user switching back to it):
    // bindView on a second view id finds the runtime already hydrated and
    // idle, so it must transparently reload again and this time pick up the
    // hand-edit.
    const secondViewId = "test-view-reload-c-2";
    const reboundSnapshot = await manager.bindView(secondViewId, c.metadata.id);
    assert.equal(reboundSnapshot.messages.length, lines.length - 1, "reopened snapshot must reflect the hand-trimmed disk content");
    assert.ok(reboundSnapshot.messages.length < beforeCount, "trimmed snapshot must have fewer messages than before the hand-edit");

    const changeEvents = autoReloadEvents.filter((e) => e.sessionId === c.metadata.id);
    assert.equal(changeEvents.length, 2, "exactly two auto-reload attempts should have fired for this session (one per bindView)");
    assert.deepEqual(changeEvents[1]!.result, { changed: true }, "the second auto-reload event must report changed:true since the message count actually differs now");

    manager.unbindView(firstViewId);
    manager.unbindView(secondViewId);
  });

  console.log("\n== automatic reload-on-open: a BUSY (mid-turn) session is never reloaded when another view binds/switches to it ==");
  await check("binding/switching to a session mid-turn attaches to its live state without reloading, leaving the in-progress turn unaffected", async () => {
    const d = await manager.createSession();
    // Hydrate + idle first, exactly like the previous check, so the upcoming
    // mid-turn bind exercises the "already hydrated" branch of
    // ensureRuntimeForOpen (not the "first hydration" branch).
    const primeViewId = "test-view-busy-d-prime";
    await manager.bindView(primeViewId, d.metadata.id);
    manager.unbindView(primeViewId);

    const runD = manager.run(d.metadata.id, { text: "long-running turn" });
    await sleep(20);
    assert.equal(manager.getRuntimePhase(d.metadata.id), "running");

    // Hand-edit the on-disk .jsonl while D is mid-turn: if the busy runtime
    // were (incorrectly) reloaded, this bogus content would corrupt its live
    // in-memory state out from under the running turn.
    const jsonlPath = path.join(vault, ".chatting", "sessions", `${d.metadata.id}.jsonl`);
    await fs.writeFile(jsonlPath, JSON.stringify({ role: "user", content: "BOGUS EXTERNAL EDIT" }) + "\n", "utf8");

    const beforeBind = autoReloadEvents.length;
    const viewId = "test-view-busy-d";
    const snapshot = await manager.bindView(viewId, d.metadata.id);
    assert.equal(snapshot.phase, "running", "bound snapshot must reflect the live running turn, not an idle reloaded one");
    assert.equal(autoReloadEvents.length, beforeBind, "no auto-reload event should fire while the session is busy");

    await runD;
    assert.equal(manager.getRuntimePhase(d.metadata.id), "idle");
    // The turn's own completion checkpoint (agent.exportMessages()) — not the
    // bogus hand-edit — must be what ends up persisted, confirming the
    // hand-edit never made it into the live runtime.
    const finalMessages = agents.get(d.metadata.id)!.exportMessages();
    assert.ok(!finalMessages.some((m) => JSON.stringify(m).includes("BOGUS EXTERNAL EDIT")), "the bogus hand-edit must never have entered the live runtime's in-memory history");

    manager.unbindView(viewId);
  });

  console.log("\n== automatic reload-on-open: a session's first hydration this run does not perform a redundant second disk read ==");
  await check("first bindView() of a never-before-opened session reads its .jsonl from disk exactly once", async () => {
    // Create the session directly via the store (bypassing
    // manager.createSession(), which itself hydrates a runtime): this way
    // the session's runtime is genuinely not yet hydrated in `manager` when
    // bindView() below runs, exercising ensureRuntimeForOpen's "not yet
    // hydrated" branch (delegates straight to ensureRuntime(), no extra
    // reload).
    const e = await store.create({ title: "first-hydration probe" });

    let readCount = 0;
    const originalLoad = store.history.load.bind(store.history);
    store.history.load = (async (id: string) => {
      if (id === e.metadata.id) readCount++;
      return originalLoad(id);
    }) as typeof store.history.load;

    const viewId = "test-view-first-hydration-e";
    await manager.bindView(viewId, e.metadata.id);
    store.history.load = originalLoad;
    manager.unbindView(viewId);

    assert.equal(readCount, 1, "first hydration of a not-yet-hydrated session must read its .jsonl exactly once, not twice (no redundant auto-reload read)");
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
    // a + b + c + d + e (from the auto-reload checks above) + 20 stress sessions, none archived.
    assert.equal(stats.activeCount, 5 + 20);
  });

  await manager.shutdown();
  console.log(`\n${passed} checks passed.`);
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
