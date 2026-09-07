import type { SessionStorageAdapter } from "../storage-adapter";

export const MIGRATION_JOURNAL_PATH = ".chatting/migrations/session-workspaces-v4.json";
export const MIGRATION_JOURNAL_SCHEMA_VERSION = 1 as const;

export type MigrationSourceKind = "v3-session" | "branch11-session" | "legacy-chat-state";
export type MigrationSourceStatus = "migrated" | "skipped" | "failed";

export interface MigrationJournalEntry {
  kind: MigrationSourceKind;
  /** Vault-relative path (or logical path) of the legacy source. */
  path: string;
  sourceId: string;
  destinationId: string;
  status: MigrationSourceStatus;
  reason?: string;
  migratedAt: number;
}

/**
 * Bookkeeping only — never canonical session truth. Canonical truth remains
 * `.chatting/session-metadata/*.meta.json` + `.chatting/sessions/*.jsonl`.
 * Safe to delete; migration will simply re-derive idempotency from the
 * canonical stores' existing destination ids on the next run.
 */
export interface MigrationJournal {
  schemaVersion: typeof MIGRATION_JOURNAL_SCHEMA_VERSION;
  completedAt: number;
  sources: MigrationJournalEntry[];
}

export function emptyJournal(): MigrationJournal {
  return { schemaVersion: MIGRATION_JOURNAL_SCHEMA_VERSION, completedAt: 0, sources: [] };
}

export class MigrationJournalStore {
  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly path = MIGRATION_JOURNAL_PATH,
  ) {}

  async load(): Promise<MigrationJournal> {
    if (!await this.adapter.exists(this.path)) return emptyJournal();
    try {
      const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
      if (!isJournal(parsed)) return emptyJournal();
      return parsed;
    } catch {
      return emptyJournal();
    }
  }

  async save(journal: MigrationJournal): Promise<void> {
    const dir = this.path.split("/").slice(0, -1).join("/");
    if (dir) await this.adapter.ensureFolder(dir);
    await this.adapter.write(this.path, JSON.stringify(journal, null, 2));
  }

  /** Record one entry and persist immediately (a crash after this point must not re-run this source). */
  async recordAndSave(journal: MigrationJournal, entry: MigrationJournalEntry): Promise<MigrationJournal> {
    const next: MigrationJournal = {
      ...journal,
      completedAt: Date.now(),
      sources: [...journal.sources.filter((s) => !(s.kind === entry.kind && s.sourceId === entry.sourceId)), entry],
    };
    await this.save(next);
    return next;
  }

  hasMigrated(journal: MigrationJournal, kind: MigrationSourceKind, sourceId: string): boolean {
    return journal.sources.some((s) => s.kind === kind && s.sourceId === sourceId && s.status === "migrated");
  }
}

function isJournal(value: unknown): value is MigrationJournal {
  return (
    !!value
    && typeof value === "object"
    && (value as MigrationJournal).schemaVersion === MIGRATION_JOURNAL_SCHEMA_VERSION
    && Array.isArray((value as MigrationJournal).sources)
  );
}
