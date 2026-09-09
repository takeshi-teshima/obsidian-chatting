// Regression check for a real user report: mobile and PC history "not
// syncing properly" turned out to be iCloud creating sync-conflict copies
// of the session-index files (manifest.json/hot.json/shards/*.json) when
// both devices wrote to the same file at nearly the same time -- iCloud
// keeps one under the canonical name and renames the other to some
// alternate filename the app never reads back, silently discarding
// whichever device's index update lost that race.
//
// Fix: SessionIndexStore.initialize() now quarantines (moves out) any file
// found in its reserved directories that isn't one of the exact filenames
// it itself ever writes, then forces a full rebuild from session-metadata
// (the real source of truth) rather than trusting a possibly-conflicted
// index. Deliberately uses a made-up conflict filename below (not any real
// sync provider's actual naming convention) to prove detection is based on
// "not a filename this store recognizes", not a hardcoded pattern.
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

async function mkVault(): Promise<{ vaultRoot: string; store: SessionWorkspaceStore }> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-index-quarantine-"));
  const app = createFakeApp(vaultRoot);
  const adapter = new ObsidianSessionStorageAdapter(app);
  const store = new SessionWorkspaceStore(
    new SessionMetadataStore(adapter),
    new ChattingHistoryStore(adapter),
    new SessionLocalStateStore(adapter),
    new SessionIndexStore(adapter),
  );
  return { vaultRoot, store };
}

async function main(): Promise<void> {
  console.log("== session-index quarantine: sync-conflict files are detected by directory reservation, not filename pattern ==");

  const { vaultRoot, store } = await mkVault();
  await store.initialize();

  // Create a couple of real sessions so there's something for the rebuild
  // to correctly reconstruct.
  const a = await store.create({ title: "Session A" });
  const b = await store.create({ title: "Session B" });

  // Simulate what a REAL Obsidian restart does: a fresh SessionWorkspaceStore
  // (fresh in-memory state) re-initializing against the same on-disk vault.
  const fresh1 = await mkFreshStoreAgainst(vaultRoot);
  await check("sanity: a normal re-initialize does NOT report any quarantined files", async () => {
    const result = await fresh1.initialize();
    assert.equal(result.quarantinedIndexPaths.length, 0);
    assert.equal(result.indexRebuilt, false, "manifest+hot are valid, no rebuild needed");
  });

  // Plant "foreign" files in both reserved directories, using a
  // deliberately-invented naming scheme (NOT a real sync provider's actual
  // conflict-copy format) to prove detection doesn't depend on recognizing
  // any specific pattern.
  const indexRoot = path.join(vaultRoot, ".chatting/session-index");
  const shardsRoot = path.join(indexRoot, "shards");
  const foreignRootFile = path.join(indexRoot, "hot__made_up_conflict_marker__.json");
  const foreignShardFile = path.join(shardsRoot, "00__made_up_conflict_marker__.json");
  await fs.writeFile(foreignRootFile, JSON.stringify({ schemaVersion: 1, generation: 999, items: [] }), "utf8");
  await fs.writeFile(foreignShardFile, JSON.stringify({ schemaVersion: 1, generation: 999, items: [] }), "utf8");

  // Legitimate .bak files (this store's own write-ahead pattern) must NOT
  // be treated as foreign.
  const legitimateBak = path.join(indexRoot, "hot.json.bak");
  const bakExistedBefore = await fs.access(legitimateBak).then(() => true).catch(() => false);

  const fresh2 = await mkFreshStoreAgainst(vaultRoot);
  let result2: Awaited<ReturnType<typeof fresh2.initialize>>;
  await check("foreign files in session-index/ and session-index/shards/ are detected and force a rebuild", async () => {
    result2 = await fresh2.initialize();
    assert.equal(result2.quarantinedIndexPaths.length, 2, JSON.stringify(result2.quarantinedIndexPaths));
    assert.equal(result2.indexRebuilt, true);
  });

  await check("quarantined files are MOVED (not deleted) to .chatting/sync-conflicts/, preserving relative structure", async () => {
    assert.equal(await fs.access(foreignRootFile).then(() => true).catch(() => false), false, "must be gone from its original location");
    assert.equal(await fs.access(foreignShardFile).then(() => true).catch(() => false), false, "must be gone from its original location");

    const quarantinedRoot = path.join(vaultRoot, ".chatting/sync-conflicts/session-index/hot__made_up_conflict_marker__.json");
    const quarantinedShard = path.join(vaultRoot, ".chatting/sync-conflicts/session-index/shards/00__made_up_conflict_marker__.json");
    assert.equal(await fs.access(quarantinedRoot).then(() => true).catch(() => false), true, "must exist under sync-conflicts/session-index/");
    assert.equal(await fs.access(quarantinedShard).then(() => true).catch(() => false), true, "must exist under sync-conflicts/session-index/shards/");
  });

  await check("a legitimate .bak file is left in place, not quarantined as foreign", async () => {
    if (bakExistedBefore) {
      assert.equal(await fs.access(legitimateBak).then(() => true).catch(() => false), true);
    }
    // Either way, .bak must never appear in the quarantine list.
    assert.ok(!result2!.quarantinedIndexPaths.some((p) => p.endsWith(".bak")));
  });

  await check("after quarantine + rebuild, both real sessions are still correctly present (rebuilt from session-metadata, the source of truth)", async () => {
    const queryResult = await fresh2.query({});
    const ids = queryResult.items.map((item) => item.id);
    assert.ok(ids.includes(a.metadata.id), "session A must survive the rebuild");
    assert.ok(ids.includes(b.metadata.id), "session B must survive the rebuild");
  });

  console.log(`\n${passed} checks passed.`);
}

async function mkFreshStoreAgainst(vaultRoot: string): Promise<SessionWorkspaceStore> {
  const app = createFakeApp(vaultRoot);
  const adapter = new ObsidianSessionStorageAdapter(app);
  return new SessionWorkspaceStore(
    new SessionMetadataStore(adapter),
    new ChattingHistoryStore(adapter),
    new SessionLocalStateStore(adapter),
    new SessionIndexStore(adapter),
  );
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
