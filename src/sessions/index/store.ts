import type { SessionStorageAdapter } from "../storage-adapter";
import type { ConversationMeta } from "../metadata/types";
import { sortConversationMeta } from "./derived-index";

export const DEFAULT_SESSION_INDEX_ROOT = ".chatting/session-index";
export const SESSION_INDEX_HOT_PATH = `${DEFAULT_SESSION_INDEX_ROOT}/hot.json`;
export const SESSION_INDEX_SCHEMA_VERSION = 1 as const;

interface SessionIndexFile {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  entries: ConversationMeta[];
}

/**
 * Simplified derived/rebuildable navigation index.
 *
 * STORAGE_AND_SCALE.md describes a 64-way sharded `session-index/` cache for
 * very large session counts (ported from the v3 hot/sharded catalog). This
 * single-file "hot" implementation intentionally covers the common case
 * (dozens to low thousands of sessions) with the same contract — derived,
 * disposable, never canonical, rebuildable from `session-metadata/*.meta.json`
 * without hydrating every transcript. Sharding is a follow-up scale
 * optimization the migration/runtime contract does not require to land in
 * this pass; nothing here forecloses moving `entries` into per-shard files
 * later since callers only see `list()`/`upsert()`/`remove()`.
 */
export class SessionIndexStore {
  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly path = SESSION_INDEX_HOT_PATH,
  ) {}

  async load(): Promise<ConversationMeta[]> {
    if (!await this.adapter.exists(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
      if (!isIndexFile(parsed)) return [];
      return parsed.entries;
    } catch {
      return [];
    }
  }

  async save(entries: readonly ConversationMeta[]): Promise<void> {
    const dir = this.path.split("/").slice(0, -1).join("/");
    if (dir) await this.adapter.ensureFolder(dir);
    const file: SessionIndexFile = {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      entries: sortConversationMeta(entries),
    };
    await this.adapter.write(this.path, JSON.stringify(file, null, 2));
  }

  async upsert(entry: ConversationMeta): Promise<void> {
    const entries = await this.load();
    const next = [...entries.filter((e) => e.id !== entry.id), entry];
    await this.save(next);
  }

  async remove(id: string): Promise<void> {
    const entries = await this.load();
    await this.save(entries.filter((e) => e.id !== id));
  }
}

function isIndexFile(value: unknown): value is SessionIndexFile {
  return (
    !!value
    && typeof value === "object"
    && Array.isArray((value as SessionIndexFile).entries)
  );
}
