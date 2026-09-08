import { SessionMetadataStore } from "../metadata/store";
import { ChattingHistoryStore } from "../history/store";
import { SessionIndexStore } from "../index/store";
import type { SessionStorageAdapter } from "../storage-adapter";
import { MigrationJournalStore } from "./journal";
import type { LegacyReadAdapter } from "./legacy-adapter";
import { scanV3Sessions } from "./from-v3";
import { scanBranch11Sessions } from "./from-branch11";
import { readLegacyChatState } from "./from-legacy-chat-state";
import { importLegacySession } from "./import-legacy-session";
import type { MigrationSummary } from "./types";

export interface RunMigrationOptions {
  /** Vault-relative canonical storage adapter (writes only `.chatting/...`). */
  canonicalAdapter: SessionStorageAdapter;
  /** Read-only adapter over the plugin data dir tree (legacy sources). */
  legacyAdapter: LegacyReadAdapter;
  /** e.g. `${app.vault.configDir}/plugins/chatting-with-ai` */
  pluginDataDir: string;
  /** Additional legacy chat-state.json candidate paths, checked in order. */
  legacyChatStatePaths: readonly string[];
  /** Used only for the single legacy active chat (see from-legacy-chat-state.ts). */
  currentProvider?: string;
  currentModel?: string;
}

/**
 * Orchestrates the full v4 migration bootstrap per MIGRATION_HANDOFF.md §12:
 *
 *   initialize v4 stores
 *     -> import all valid old branch-11/v3 sessions
 *     -> if none, import first valid legacy single chat
 *     -> (a blank session is the caller's responsibility if this yields nothing)
 *
 * Non-destructive: never deletes/overwrites any legacy source. Idempotent:
 * safe to call on every startup — already-migrated sessions are skipped via
 * the migration journal AND a direct existing-destination check, so a lost
 * journal doesn't cause duplicate imports as long as destination ids are
 * unchanged.
 */
export async function runMigration(options: RunMigrationOptions): Promise<MigrationSummary> {
  const metadataStore = new SessionMetadataStore(options.canonicalAdapter);
  const historyStore = new ChattingHistoryStore(options.canonicalAdapter);
  const indexStore = new SessionIndexStore(options.canonicalAdapter);
  const journalStore = new MigrationJournalStore(options.canonicalAdapter);
  const deps = { metadataStore, historyStore, indexStore, journalStore };

  const summary: MigrationSummary = {
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    diagnostics: [],
    destinationIds: [],
  };

  let journal = await journalStore.load();

  // Priority order per the real-data situation this migration targets: v3 is
  // the only store with genuinely current content, so it is scanned first
  // and its sessions are migrated first (destination ids/collisions from v3
  // therefore win over branch-11 if both happen to reuse the same id).
  const v3Sources = await scanV3Sessions(options.legacyAdapter, options.pluginDataDir, summary.diagnostics);
  const branch11Sources = await scanBranch11Sessions(options.legacyAdapter, options.pluginDataDir, summary.diagnostics);

  const taggedSources: Array<{ path: string; session: typeof v3Sources[number]["session"]; kind: "v3-session" | "branch11-session" }> = [
    ...v3Sources.map((s) => ({ ...s, kind: "v3-session" as const })),
    ...branch11Sources.map((s) => ({ ...s, kind: "branch11-session" as const })),
  ];

  for (const { path, session, kind: resolvedKind } of taggedSources) {
    const { result, journal: nextJournal } = await importLegacySession(deps, resolvedKind, path, session, journal);
    journal = nextJournal;
    summary.diagnostics.push(...result.diagnostics);
    if (result.status === "migrated") {
      summary.migratedCount++;
      if (result.destinationId) summary.destinationIds.push(result.destinationId);
    } else if (result.status === "skipped") {
      summary.skippedCount++;
      if (result.destinationId) summary.destinationIds.push(result.destinationId);
    } else {
      summary.failedCount++;
    }
  }

  // Per §12: the single legacy chat-state.json is only a migration source
  // when there is no branch-11/v3 data at all — otherwise its content is a
  // strict predecessor of what v3/branch11 already captured, and importing
  // it too would fabricate a phantom 6th/duplicate conversation.
  if (v3Sources.length === 0 && branch11Sources.length === 0) {
    const legacy = await readLegacyChatState(
      options.legacyAdapter,
      options.legacyChatStatePaths,
      options.currentProvider,
      options.currentModel,
    );
    if (legacy) {
      const { result, journal: nextJournal } = await importLegacySession(
        deps,
        "legacy-chat-state",
        legacy.path,
        legacy.session,
        journal,
      );
      journal = nextJournal;
      summary.diagnostics.push(...result.diagnostics);
      if (result.status === "migrated") {
        summary.migratedCount++;
        if (result.destinationId) summary.destinationIds.push(result.destinationId);
      } else if (result.status === "skipped") {
        summary.skippedCount++;
        if (result.destinationId) summary.destinationIds.push(result.destinationId);
      } else {
        summary.failedCount++;
      }
    }
  }

  return summary;
}
