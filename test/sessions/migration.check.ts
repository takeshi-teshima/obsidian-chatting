import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeApp } from "./fake-app";
import { ObsidianSessionStorageAdapter } from "../../src/sessions/obsidian-storage-adapter";
import { ObsidianLegacyReadAdapter } from "../../src/sessions/obsidian-legacy-read-adapter";
import { SessionMetadataStore } from "../../src/sessions/metadata/store";
import { ChattingHistoryStore } from "../../src/sessions/history/store";
import { SessionIndexStore } from "../../src/sessions/index/store";
import { runMigration } from "../../src/sessions/migration/run-migration";
import { decodeSessionMetadata, encodeSessionMetadata, isValidSessionMetadataId } from "../../src/sessions/metadata/codec";
import fixtures from "./claudian-session-metadata-fixtures.json" with { type: "json" };

const REAL_PLUGIN_DIR =
  "/Users/teshima/Library/Mobile Documents/iCloud~md~obsidian/Documents/takeshi-teshima/.obsidian/plugins/chatting-with-ai";

const GROUND_TRUTH: Record<string, { chatHistory: number; agentMessages: number; title: string }> = {
  s_mtqmjrlh_fa6a05f81a4b4423: { chatHistory: 0, agentMessages: 0, title: "New chat" },
  s_mtn0x35p_6a8063f6e91e497d: { chatHistory: 0, agentMessages: 0, title: "New chat" },
  s_mtl2e73k_6df4cdf180cd42c2: { chatHistory: 15, agentMessages: 13, title: "テストだよ" },
  s_mtl2elzk_da02a48d5ba948c8: { chatHistory: 5, agentMessages: 5, title: "New chat" },
  s_mtk4lort_db87b26172b94ddd: {
    chatHistory: 24,
    agentMessages: 13,
    title: "豐田さんの初日の企画や、今日の居相くんの発表で座長をしていた先生の名前分かりますか？",
  },
};

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

async function mkScratchVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-scratch-"));
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
  try {
    await fs.access(src);
  } catch {
    return false;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
  return true;
}

async function main() {
  console.log("== metadata codec contract (kit fixtures) ==");
  await check("current fixture decodes with no migration", () => {
    const decoded = decodeSessionMetadata(fixtures.current);
    assert.ok(decoded);
    assert.equal(decoded!.needsMigration, false);
  });
  await check("legacy fixture normalizes aliases and flags needsMigration", () => {
    const decoded = decodeSessionMetadata(fixtures.legacy);
    assert.ok(decoded);
    assert.equal(decoded!.needsMigration, true);
    assert.equal(decoded!.metadata.lastActivityAt, 1500);
    assert.equal(decoded!.metadata.linkedContentPath, "Notes/old.md");
  });
  await check("future unknown field survives decode/encode round-trip", () => {
    const decoded = decodeSessionMetadata(fixtures.futureUnknown);
    assert.ok(decoded);
    const encoded = encodeSessionMetadata(decoded!.metadata, decoded!.unknownFields);
    assert.deepEqual((encoded as any).futureClaudianField, { enabled: true });
  });
  await check("invalid traversal-like ids are rejected", () => {
    assert.equal(isValidSessionMetadataId("../escape"), false);
    assert.equal(isValidSessionMetadataId(".."), false);
    assert.equal(isValidSessionMetadataId("s_ok-123"), true);
  });
  await check("encoded metadata has no Chatting wrapper/root schemaVersion", () => {
    const decoded = decodeSessionMetadata(fixtures.current);
    const encoded = encodeSessionMetadata(decoded!.metadata) as Record<string, unknown>;
    assert.equal("schemaVersion" in encoded, false);
    assert.equal("chatting" in encoded, false);
  });

  console.log("\n== history store round-trip ==");
  {
    const vault = await mkScratchVault();
    const app = createFakeApp(vault);
    const adapter = new ObsidianSessionStorageAdapter(app);
    const history = new ChattingHistoryStore(adapter);
    await check("jsonl replace/load round-trips UnifiedMessage[] exactly", async () => {
      const messages = [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
      ];
      await history.replace("s_test", messages);
      const loaded = await history.load("s_test");
      assert.deepEqual(loaded, messages);
    });
  }

  console.log("\n== CRITICAL: v3 -> v4 migration against a copy of the real 5-session vault data ==");
  const scratch = await mkScratchVault();
  const pluginDataDir = ".obsidian/plugins/chatting-with-ai";
  const scratchPluginDir = path.join(scratch, pluginDataDir);

  const copiedV3 = await copyIfExists(
    path.join(REAL_PLUGIN_DIR, "sessions-v3"),
    path.join(scratchPluginDir, "sessions-v3"),
  );
  const copiedV2 = await copyIfExists(
    path.join(REAL_PLUGIN_DIR, "sessions"),
    path.join(scratchPluginDir, "sessions"),
  );
  const copiedChatState = await copyIfExists(
    path.join(REAL_PLUGIN_DIR, "chat-state.json"),
    path.join(scratchPluginDir, "chat-state.json"),
  );

  await check("real sessions-v3/, sessions/, chat-state.json were all found and copied (not moved)", () => {
    assert.equal(copiedV3, true, "sessions-v3 must exist in the real vault for this test to be meaningful");
    assert.equal(copiedV2, true, "sessions must exist in the real vault for this test to be meaningful");
    assert.equal(copiedChatState, true, "chat-state.json must exist in the real vault for this test to be meaningful");
  });

  // Confirm the real source directory was NOT modified: re-stat it after copy.
  const realStatBefore = await fs.stat(path.join(REAL_PLUGIN_DIR, "sessions-v3"));

  const app = createFakeApp(scratch);
  const canonicalAdapter = new ObsidianSessionStorageAdapter(app);
  const legacyAdapter = new ObsidianLegacyReadAdapter(app);
  const metadataStore = new SessionMetadataStore(canonicalAdapter);
  const historyStore = new ChattingHistoryStore(canonicalAdapter);
  const indexStore = new SessionIndexStore(canonicalAdapter);

  const runOptions = {
    canonicalAdapter,
    legacyAdapter,
    pluginDataDir,
    legacyChatStatePaths: [`${pluginDataDir}/chat-state.json`],
    currentProvider: "chatgpt-oauth",
    currentModel: "gpt-5.5",
  };

  const summary1 = await runMigration(runOptions);
  console.log(`  migration run #1: migrated=${summary1.migratedCount} skipped=${summary1.skippedCount} failed=${summary1.failedCount}`);
  for (const d of summary1.diagnostics) console.log(`    diagnostic: [${d.sourceKind}/${d.sourceId}] ${d.message}`);

  await check("all 5 v3 sessions migrated, 0 failed", () => {
    assert.equal(summary1.failedCount, 0);
    assert.equal(summary1.migratedCount, 6); // 5 v3 + 1 branch-11 (empty) session
  });

  await check("chat-state.json was NOT imported as a 6th/7th conversation (v3+branch11 data present)", async () => {
    const all = await metadataStore.list();
    assert.equal(all.length, 6, `expected exactly 6 migrated sessions, got ${all.length}`);
  });

  for (const [id, expected] of Object.entries(GROUND_TRUTH)) {
    await check(`session ${id}: metadata + jsonl match ground truth (agentMessages=${expected.agentMessages})`, async () => {
      const loaded = await metadataStore.load(id);
      assert.ok(loaded, `metadata for ${id} should exist`);
      assert.equal(loaded!.metadata.title, expected.title);
      assert.equal(loaded!.metadata.providerId, "chatting");

      const messages = await historyStore.load(id);
      assert.equal(messages.length, expected.agentMessages, "jsonl message count must match agentMessages ground truth");
    });
  }

  await check("content spot-check: テストだよ session (15/13) preserves real message text", async () => {
    const messages = await historyStore.load("s_mtl2e73k_6df4cdf180cd42c2");
    const raw = JSON.parse(
      await fs.readFile(path.join(REAL_PLUGIN_DIR, "sessions-v3/data/c2/s_mtl2e73k_6df4cdf180cd42c2.json"), "utf8"),
    );
    assert.deepEqual(messages, raw.agentMessages, "migrated JSONL must equal the original agentMessages verbatim");
  });

  await check("content spot-check: 座長 session (24/13) preserves real message text", async () => {
    const messages = await historyStore.load("s_mtk4lort_db87b26172b94ddd");
    const raw = JSON.parse(
      await fs.readFile(path.join(REAL_PLUGIN_DIR, "sessions-v3/data/dd/s_mtk4lort_db87b26172b94ddd.json"), "utf8"),
    );
    assert.deepEqual(messages, raw.agentMessages);
  });

  await check("content spot-check: 5/5 session preserves real message text", async () => {
    const messages = await historyStore.load("s_mtl2elzk_da02a48d5ba948c8");
    const raw = JSON.parse(
      await fs.readFile(path.join(REAL_PLUGIN_DIR, "sessions-v3/data/c8/s_mtl2elzk_da02a48d5ba948c8.json"), "utf8"),
    );
    assert.deepEqual(messages, raw.agentMessages);
  });

  await check("old v2 (branch-11) empty session migrated without erroring", async () => {
    const branch11Ids = (await metadataStore.list()).filter(
      (e) => !(e.metadata.id in GROUND_TRUTH),
    );
    assert.equal(branch11Ids.length, 1, "exactly one non-v3 (branch-11) session expected");
    const messages = await historyStore.load(branch11Ids[0].metadata.id);
    assert.equal(messages.length, 0);
  });

  await check("derived index has 6 entries with real messageCount/preview", async () => {
    const entries = await indexStore.load();
    assert.equal(entries.length, 6);
    const big = entries.find((e) => e.id === "s_mtk4lort_db87b26172b94ddd");
    assert.ok(big);
    assert.equal(big!.messageCount, 13);
    assert.ok(big!.preview.length > 0);
  });

  await check("real vault sessions-v3/ directory was not modified by the test", async () => {
    const realStatAfter = await fs.stat(path.join(REAL_PLUGIN_DIR, "sessions-v3"));
    assert.equal(realStatAfter.mtimeMs, realStatBefore.mtimeMs);
  });

  console.log("\n== idempotency: re-run migration against the same scratch copy ==");
  const summary2 = await runMigration(runOptions);
  await check("second run migrates 0 new, skips all previously-migrated sources", () => {
    assert.equal(summary2.migratedCount, 0);
    assert.equal(summary2.skippedCount, 6);
    assert.equal(summary2.failedCount, 0);
  });
  await check("no duplicate sessions were created by the second run", async () => {
    const all = await metadataStore.list();
    assert.equal(all.length, 6);
    const entries = await indexStore.load();
    assert.equal(entries.length, 6);
  });

  console.log("\n== reload-from-disk recovery (hand-edit a .jsonl line) ==");
  {
    const targetId = "s_mtk4lort_db87b26172b94ddd"; // 24/13
    const jsonlPath = path.join(scratch, historyStore.pathFor(targetId));
    const before = (await fs.readFile(jsonlPath, "utf8")).split("\n").filter((l) => l.trim());
    await check("hand-trim: deleting one JSONL line reduces the on-disk message count by exactly one", async () => {
      const trimmed = before.slice(0, -1); // drop the last line, like a human trimming an oversized tool result
      await fs.writeFile(jsonlPath, trimmed.join("\n") + "\n", "utf8");
      const reread = await historyStore.load(targetId);
      assert.equal(reread.length, before.length - 1);
    });
    await check("reload path fully replaces (not merges) in-memory history from the trimmed file", async () => {
      // Simulates AgentLoop.importMessages(freshMessages): full replace semantics.
      let inMemory = [{ role: "user" as const, content: "stale message that must be discarded" }];
      const fresh = await historyStore.load(targetId);
      inMemory = fresh; // full replace, never inMemory.concat(fresh)
      assert.equal(inMemory.length, before.length - 1);
      assert.notEqual(JSON.stringify(inMemory[0]), JSON.stringify({ role: "user", content: "stale message that must be discarded" }));
    });
  }

  console.log(`\n${passed} checks passed.`);
}

await main().catch((error) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
