// Regression check for a real production incident: immediately after
// deploying the quarantine-triggered rebuild (session-index-quarantine.check.ts),
// a live reload's rebuildSource() (session-metadata's file listing)
// transiently came back completely empty even though 16 real sessions'
// metadata files were sitting on disk -- a retry moments later found all of
// them. The rebuild blindly committed that empty result, replacing a real
// 16-session index with an effectively-empty one; main.ts's "no sessions at
// all" fallback then created a throwaway blank session, masking (not
// fixing) the problem. No actual session data was lost (session-metadata/
// *.meta.json and the .jsonl transcripts were untouched) but the
// user-visible conversation list appeared to have been wiped.
//
// Fix (in SessionIndexStore.initialize()): retry a few times before
// trusting an empty rebuildSource() result, and if a PREVIOUS manifest is
// known to have had real sessions, never commit an empty rebuild over it
// even after retries -- keep serving the previous index and report the
// failure via `rebuildRefused` instead.
import assert from "node:assert/strict";
import type { ConversationMeta } from "../../src/sessions/metadata/types";
import type { SessionStorageAdapter } from "../../src/sessions/storage-adapter";
import { SessionIndexStore } from "../../src/sessions/index/store";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}`);
    console.error(error);
    process.exitCode = 1;
    throw error;
  }
}

/** Minimal in-memory SessionStorageAdapter -- fast, deterministic, no real fs/timing dependencies of its own. */
function makeMemoryAdapter(): SessionStorageAdapter {
  const files = new Map<string, string>();
  return {
    async exists(p) { return files.has(p); },
    async read(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async write(p, contents) { files.set(p, contents); },
    async remove(p) { files.delete(p); },
    async rename(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT (rename from): ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    async ensureFolder() { /* no-op: this in-memory adapter has no real directories */ },
    async listFiles(prefix) {
      return [...files.keys()].filter((p) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes("/"));
    },
  };
}

function meta(id: string, title: string): ConversationMeta {
  return {
    id,
    providerId: "chatting",
    title,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 1,
    preview: "hi",
    isPinned: false,
    isArchived: false,
  };
}

async function main(): Promise<void> {
  console.log("== session-index rebuild guard: transient empty rebuildSource() results ==");

  await check("a transient empty result followed by a successful retry is NOT treated as real emptiness", async () => {
    const adapter = makeMemoryAdapter();
    const store = new SessionIndexStore(adapter);
    const real = [meta("s_a", "Session A"), meta("s_b", "Session B")];

    // First initialize(): establish a real, non-empty index.
    await store.initialize(async () => real);
    const before = await store.getStats();
    assert.equal(before.activeCount, 2);

    // Force a rebuild on the NEXT initialize() by planting a foreign file
    // (mirrors how the real incident's rebuild got triggered), and make the
    // rebuild source fail twice (simulating the observed transient glitch)
    // before succeeding on the third call.
    await adapter.write(".chatting/session-index/hot__conflict__.json", "{}");
    let callCount = 0;
    const flakySource = async (): Promise<ConversationMeta[]> => {
      callCount++;
      if (callCount <= 2) return [];
      return real;
    };

    const store2 = new SessionIndexStore(adapter);
    const result = await store2.initialize(flakySource);
    assert.equal(result.quarantinedPaths.length, 1);
    assert.equal(result.rebuildRefused, false, "must not give up -- the retry should have succeeded");
    assert.equal(result.rebuilt, true);
    assert.equal(result.stats.activeCount, 2, "must reflect the REAL data once the retry succeeded, not the transient empty read");
  });

  await check("empty results on EVERY attempt, with real prior data, refuses to overwrite (data is not lost, index just stays stale)", async () => {
    const adapter = makeMemoryAdapter();
    const store = new SessionIndexStore(adapter);
    const real = [meta("s_a", "Session A"), meta("s_b", "Session B"), meta("s_c", "Session C")];
    await store.initialize(async () => real);

    await adapter.write(".chatting/session-index/hot__conflict__.json", "{}");
    const alwaysEmptySource = async (): Promise<ConversationMeta[]> => [];

    const store2 = new SessionIndexStore(adapter);
    const result = await store2.initialize(alwaysEmptySource);
    assert.equal(result.rebuildRefused, true);
    assert.equal(result.rebuilt, false, "must not have committed the empty rebuild");
    assert.equal(result.stats.activeCount, 3, "the PREVIOUS (real) stats must still be served, not zeroed out");

    // The foreign file must still have been quarantined regardless -- that
    // part is always safe and doesn't depend on whether the rebuild itself
    // succeeded.
    assert.equal(result.quarantinedPaths.length, 1);
  });

  await check("a genuinely empty vault (no previous sessions at all) is NOT held to the refuse-to-overwrite guard", async () => {
    const adapter = makeMemoryAdapter();
    const store = new SessionIndexStore(adapter);
    const result = await store.initialize(async () => []);
    assert.equal(result.rebuildRefused, false, "a fresh vault legitimately has zero sessions -- must not be treated as a failure");
    assert.equal(result.rebuilt, true);
    assert.equal(result.stats.activeCount, 0);
  });

  console.log(`\n${passed} checks passed.`);
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
