import type { ConversationMeta } from "../metadata/types";
import type { SessionStorageAdapter } from "../storage-adapter";
import type { SessionQuery, SessionQueryResult, SessionStoreStats } from "../runtime/types";
import { SerialQueue } from "../runtime/async-lock";

export const SESSION_INDEX_SCHEMA_VERSION = 1 as const;
export const SESSION_INDEX_SHARDS = 64 as const;
export const SESSION_HOT_RECENT_LIMIT = 512 as const;
export const DEFAULT_SESSION_INDEX_ROOT = ".chatting/session-index";

interface SessionIndexManifest {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  generation: number;
  activeCount: number;
  archivedCount: number;
  pinnedCount: number;
  shardCount: typeof SESSION_INDEX_SHARDS;
  hotRecentLimit: typeof SESSION_HOT_RECENT_LIMIT;
  hotNeedsRefill?: boolean;
  lastRebuildAt?: number;
}

interface SessionIndexShard {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  generation: number;
  items: ConversationMeta[];
}

export interface SessionIndexInitializeResult {
  rebuilt: boolean;
  stats: SessionStoreStats;
  /**
   * Vault-relative paths of files found inside this store's own reserved
   * directories (`session-index/`, `session-index/shards/`) that were NOT
   * one of the exact filenames this store itself ever writes, and were
   * therefore moved out to `.chatting/sync-conflicts/...` before this
   * initialize() call rebuilt the index from scratch. See
   * `quarantineForeignFiles()`'s doc comment for why this is detected by
   * directory reservation rather than by matching any specific
   * sync-provider's conflict-naming convention. Empty on a normal startup.
   */
  quarantinedPaths: string[];
  /**
   * True when a rebuild was needed but got refused because `rebuildSource()`
   * came back empty (even after retries) while a previous non-empty index
   * existed -- see the safety guard in `initialize()`. The previous index
   * is left in place untouched; this only ever means "the index may now be
   * stale/still contain quarantined-conflict-tainted entries" (harmless --
   * quarantining never removes canonical files), never "sessions were
   * lost". Surfaced so the caller can warn the user rather than stay silent.
   */
  rebuildRefused: boolean;
}

/**
 * Disposable/rebuildable navigation index. Canonical data remains
 * SessionMetadata + Chatting provider-native JSONL history.
 *
 * Startup reads only manifest.json + hot.json. Archive/search/deep pagination
 * lazily read the 64 metadata shards, never transcripts.
 */
export class SessionIndexStore {
  private readonly manifestPath: string;
  private readonly hotPath: string;
  private readonly shardsRoot: string;
  private manifest: SessionIndexManifest | null = null;
  private hot: SessionIndexShard | null = null;
  private allCache: ConversationMeta[] | null = null;
  private readonly shardCache = new Map<string, SessionIndexShard>();
  /**
   * manifest.json/hot.json (and, per-key, each shard file) are shared
   * singleton state written by every session's checkpoint/finish path. Since
   * different sessions are explicitly allowed to run concurrently (that's
   * the whole point of the multi-session runtime), upsert()/remove()/
   * rebuild() calls from two sessions completing turns at nearly the same
   * moment must never interleave their write-tmp/rename-to-bak/rename-to-
   * final sequences on these shared files, or one write's rename can find
   * the path already moved by the other and throw ENOENT. All mutations
   * are therefore funneled through this single queue.
   */
  private readonly writeQueue = new SerialQueue();

  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly root = DEFAULT_SESSION_INDEX_ROOT,
  ) {
    this.manifestPath = `${root}/manifest.json`;
    this.hotPath = `${root}/hot.json`;
    this.shardsRoot = `${root}/shards`;
  }

  async initialize(rebuildSource: () => Promise<ConversationMeta[]>): Promise<SessionIndexInitializeResult> {
    await this.adapter.ensureFolder(this.root);
    await this.adapter.ensureFolder(this.shardsRoot);
    // Real report: two devices (mobile + PC) syncing the same vault via
    // iCloud each wrote to manifest.json/hot.json/a shard independently,
    // and iCloud -- which has no way to merge two divergent JSON files --
    // kept one under the canonical name and renamed the other to an
    // alternate filename the app never reads back, silently discarding
    // whichever device's index update lost that race. Since this whole
    // directory is fully re-derivable from session-metadata (the actual
    // source of truth, see `rebuildIndexSource()`), the fix is to detect
    // ANY unexpected file here and force a full rebuild rather than trust
    // whatever happens to be sitting under the canonical names.
    const quarantinedPaths = await this.quarantineForeignFiles();
    this.manifest = await this.readJson(this.manifestPath, isManifest);
    this.hot = await this.readJson(this.hotPath, isShard);
    let rebuilt = false;
    let rebuildRefused = false;
    if (!this.manifest || !this.hot || quarantinedPaths.length > 0) {
      // Observed in production immediately after shipping the quarantine
      // logic above: a rebuild triggered right after plugin reload
      // occasionally saw `rebuildSource()` (session-metadata's file
      // listing) come back completely empty, even though 16 real sessions'
      // metadata files were sitting right there on disk and a retry a
      // moment later found all of them correctly -- almost certainly a
      // transient race in the underlying vault adapter's directory listing
      // right after startup, not a real "zero sessions" state. Blindly
      // committing that empty result replaced a real 16-session index with
      // an effectively-empty one (main.ts's "no sessions at all" fallback
      // then created a throwaway blank session, masking the problem rather
      // than surfacing it). Guard against this two ways: (1) retry a few
      // times before trusting an empty result at all, (2) if a PREVIOUS
      // manifest is known to have had real sessions, never commit an empty
      // rebuild over it even after retries -- keep serving the previous
      // (still content-valid; only quarantining removed anything, and that
      // only touched extra foreign files, never the canonical ones already
      // loaded into `this.manifest`/`this.hot` above) index instead, and
      // report the failure loudly so it can be investigated.
      const previouslyHadSessions = ((this.manifest?.activeCount ?? 0) + (this.manifest?.archivedCount ?? 0)) > 0;
      let items = await rebuildSource();
      for (let attempt = 0; attempt < 3 && items.length === 0; attempt++) {
        await sleep(300);
        items = await rebuildSource();
      }
      if (items.length === 0 && previouslyHadSessions) {
        rebuildRefused = true;
        console.error(
          "[chatting-with-ai] session-index rebuild source came back empty (after retries) despite a " +
            "non-empty previous index -- refusing to overwrite. Session metadata on disk was NOT touched; " +
            "this only affects the navigation index. Investigate session-metadata directory listing reliability."
        );
      } else {
        await this.rebuild(items);
        rebuilt = true;
      }
    }
    return { rebuilt, stats: await this.getStats(), quarantinedPaths, rebuildRefused };
  }

  /**
   * `session-index/` (and its `shards/` subfolder) is reserved exclusively
   * for this store's own files: `manifest.json`, `hot.json`, each
   * `<shard>.json`, and their `.tmp`/`.bak` write-ahead variants (see
   * `writeJson()`/`readJson()` below -- those are normal, expected, NOT
   * conflicts). Deliberately does NOT pattern-match any specific
   * sync-provider's conflict-copy naming convention (e.g. iCloud's
   * "NAME 2.json") -- that's provider-specific and not this code's concern.
   * Instead: this store knows the exact, complete set of filenames it ever
   * writes here, so anything else found in these two directories can only
   * be an artifact of something outside this store's control (most likely
   * a sync conflict copy), full stop, regardless of what it happens to be
   * named. Quarantined files are MOVED (never deleted) to
   * `.chatting/sync-conflicts/session-index/...`, preserving the relative
   * subpath, so nothing is silently destroyed and a user/developer can
   * inspect what was found.
   */
  private async quarantineForeignFiles(): Promise<string[]> {
    const quarantined: string[] = [];
    const expectedRoot = expectedIndexFilenames(["manifest.json", "hot.json"]);
    const rootFiles = await this.adapter.listFiles(this.root);
    for (const path of rootFiles) {
      if (path === this.shardsRoot) continue; // listFiles should only return files, but be defensive
      if (expectedRoot.has(basename(path))) continue;
      await this.quarantineFile(path, "session-index");
      quarantined.push(path);
    }

    const shardBases: string[] = [];
    for (let i = 0; i < SESSION_INDEX_SHARDS; i++) shardBases.push(`${i.toString(16).padStart(2, "0")}.json`);
    const expectedShards = expectedIndexFilenames(shardBases);
    const shardFiles = await this.adapter.listFiles(this.shardsRoot);
    for (const path of shardFiles) {
      if (expectedShards.has(basename(path))) continue;
      await this.quarantineFile(path, "session-index/shards");
      quarantined.push(path);
    }

    return quarantined;
  }

  /** `this.root` is ".chatting/session-index" -- quarantine goes to a sibling ".chatting/sync-conflicts/<subdir>", never inside a directory this store itself scans. */
  private async quarantineFile(path: string, subdir: string): Promise<void> {
    const base = this.root.split("/").slice(0, -1).join("/") || ".";
    const quarantineDir = `${base}/sync-conflicts/${subdir}`;
    await this.adapter.ensureFolder(quarantineDir);
    const name = basename(path);
    let target = `${quarantineDir}/${name}`;
    let n = 1;
    while (await this.adapter.exists(target)) {
      target = `${quarantineDir}/${Date.now()}_${n}_${name}`;
      n++;
    }
    await this.adapter.rename(path, target);
  }

  async getStats(): Promise<SessionStoreStats> {
    const manifest = this.requireManifest();
    return {
      activeCount: manifest.activeCount,
      archivedCount: manifest.archivedCount,
      pinnedCount: manifest.pinnedCount,
    };
  }

  async get(id: string): Promise<ConversationMeta | null> {
    const hot = this.requireHot().items.find((item) => item.id === id);
    if (hot) return { ...hot };
    const shard = await this.loadShard(metadataShardOf(id));
    return shard.items.find((item) => item.id === id) ?? null;
  }

  async query(query: SessionQuery): Promise<SessionQueryResult> {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = clamp(query.limit ?? 50, 1, 200);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const sort = query.sort ?? "activity";

    const canUseHot = !search
      && query.scope !== "archived"
      && offset + limit <= SESSION_HOT_RECENT_LIMIT;
    const source = canUseHot ? this.requireHot().items : await this.loadAll();
    const filtered = source.filter((item) => {
      if (query.scope === "archived") {
        if (!item.isArchived) return false;
      } else if (query.scope === "pinned") {
        if (item.isArchived || !item.isPinned) return false;
      } else if (item.isArchived) {
        return false;
      }
      if (!search) return true;
      return [item.title, item.preview, item.providerId, item.selectedModel ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(search));
    });
    filtered.sort((a, b) => compareMeta(a, b, sort));

    const total = canUseHot
      ? this.totalForHotScope(query.scope)
      : filtered.length;
    const items = filtered.slice(offset, offset + limit).map((item) => ({ ...item }));
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return { items, total, offset, nextOffset };
  }

  async upsert(next: ConversationMeta, previous: ConversationMeta | null = null): Promise<void> {
    await this.writeQueue.run(async () => {
      const manifest = this.requireManifest();
      const generation = manifest.generation + 1;
      applyManifestTransition(manifest, previous, next);
      manifest.generation = generation;

      const key = metadataShardOf(next.id);
      const shard = await this.loadShard(key);
      shard.items = shard.items.filter((item) => item.id !== next.id);
      shard.items.push({ ...next });
      shard.generation = generation;
      await this.writeShard(key, shard);

      this.updateHot(next, previous, generation);
      await this.writeManifestAndHot();
      if (this.allCache) {
        this.allCache = this.allCache.filter((item) => item.id !== next.id);
        this.allCache.push({ ...next });
      }
    });
  }

  async remove(id: string, previous: ConversationMeta | null): Promise<void> {
    await this.writeQueue.run(async () => {
      const manifest = this.requireManifest();
      const generation = manifest.generation + 1;
      applyManifestTransition(manifest, previous, null);
      manifest.generation = generation;

      const key = metadataShardOf(id);
      const shard = await this.loadShard(key);
      shard.items = shard.items.filter((item) => item.id !== id);
      shard.generation = generation;
      await this.writeShard(key, shard);

      const hot = this.requireHot();
      const wasHot = hot.items.some((item) => item.id === id);
      hot.items = hot.items.filter((item) => item.id !== id);
      hot.generation = generation;
      if (wasHot && manifest.activeCount > hot.items.length) manifest.hotNeedsRefill = true;
      await this.writeManifestAndHot();
      if (this.allCache) this.allCache = this.allCache.filter((item) => item.id !== id);
    });
  }

  async rebuild(items: readonly ConversationMeta[]): Promise<void> {
    await this.writeQueue.run(async () => {
      await this.adapter.ensureFolder(this.root);
      await this.adapter.ensureFolder(this.shardsRoot);
      this.shardCache.clear();
      this.allCache = items.map((item) => ({ ...item }));
      const generation = (this.manifest?.generation ?? 0) + 1;

      const grouped = new Map<string, ConversationMeta[]>();
      for (const item of items) {
        const key = metadataShardOf(item.id);
        const bucket = grouped.get(key) ?? [];
        bucket.push({ ...item });
        grouped.set(key, bucket);
      }
      for (let i = 0; i < SESSION_INDEX_SHARDS; i++) {
        const key = i.toString(16).padStart(2, "0");
        const shard: SessionIndexShard = {
          schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
          generation,
          items: grouped.get(key) ?? [],
        };
        this.shardCache.set(key, shard);
        await this.writeJson(this.shardPath(key), shard);
      }

      this.manifest = manifestFor(items, generation);
      this.hot = buildHot(items, generation);
      await this.writeManifestAndHot();
    });
  }

  async refillHotIfNeeded(): Promise<boolean> {
    return this.writeQueue.run(async () => {
      const manifest = this.requireManifest();
      if (!manifest.hotNeedsRefill) return false;
      const all = await this.loadAll();
      this.hot = buildHot(all, manifest.generation);
      delete manifest.hotNeedsRefill;
      await this.writeManifestAndHot();
      return true;
    });
  }

  private totalForHotScope(scope: SessionQuery["scope"]): number {
    const manifest = this.requireManifest();
    if (scope === "pinned") return manifest.pinnedCount;
    if (scope === "archived") return manifest.archivedCount;
    return manifest.activeCount;
  }

  private async loadAll(): Promise<ConversationMeta[]> {
    if (this.allCache) return this.allCache.map((item) => ({ ...item }));
    const all: ConversationMeta[] = [];
    for (let i = 0; i < SESSION_INDEX_SHARDS; i++) {
      const key = i.toString(16).padStart(2, "0");
      const shard = await this.loadShard(key);
      all.push(...shard.items.map((item) => ({ ...item })));
    }
    this.allCache = all;
    return all.map((item) => ({ ...item }));
  }

  private async loadShard(key: string): Promise<SessionIndexShard> {
    const cached = this.shardCache.get(key);
    if (cached) return cached;
    const loaded = await this.readJson(this.shardPath(key), isShard)
      ?? { schemaVersion: SESSION_INDEX_SCHEMA_VERSION, generation: 0, items: [] };
    this.shardCache.set(key, loaded);
    return loaded;
  }

  private updateHot(next: ConversationMeta, previous: ConversationMeta | null, generation: number): void {
    const manifest = this.requireManifest();
    const hot = this.requireHot();
    const wasHot = hot.items.some((item) => item.id === next.id);
    hot.items = hot.items.filter((item) => item.id !== next.id);
    if (!next.isArchived) hot.items.push({ ...next });
    const pinned = hot.items.filter((item) => !item.isArchived && item.isPinned).sort(compareActivity);
    const pinnedIds = new Set(pinned.map((item) => item.id));
    const recent = hot.items
      .filter((item) => !item.isArchived && !pinnedIds.has(item.id))
      .sort(compareActivity)
      .slice(0, SESSION_HOT_RECENT_LIMIT);
    hot.items = [...pinned, ...recent];
    hot.generation = generation;
    if (wasHot && next.isArchived && manifest.activeCount > hot.items.length) manifest.hotNeedsRefill = true;
    if (previous?.isPinned && !next.isPinned && manifest.activeCount > hot.items.length) manifest.hotNeedsRefill = true;
  }

  private requireManifest(): SessionIndexManifest {
    if (!this.manifest) throw new Error("SessionIndexStore not initialized");
    return this.manifest;
  }
  private requireHot(): SessionIndexShard {
    if (!this.hot) throw new Error("SessionIndexStore not initialized");
    return this.hot;
  }
  private shardPath(key: string): string { return `${this.shardsRoot}/${key}.json`; }

  private async writeShard(key: string, shard: SessionIndexShard): Promise<void> {
    this.shardCache.set(key, shard);
    await this.writeJson(this.shardPath(key), shard);
  }
  private async writeManifestAndHot(): Promise<void> {
    await this.writeJson(this.manifestPath, this.requireManifest());
    await this.writeJson(this.hotPath, this.requireHot());
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    JSON.parse(text);
    const tmp = `${path}.tmp`;
    const bak = `${path}.bak`;
    await this.adapter.write(tmp, text);
    if (await this.adapter.exists(path)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(path, bak);
    }
    await this.adapter.rename(tmp, path);
  }
  private async readJson<T>(path: string, guard: (value: unknown) => value is T): Promise<T | null> {
    for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
      try {
        if (!await this.adapter.exists(candidate)) continue;
        const value = JSON.parse(await this.adapter.read(candidate)) as unknown;
        if (guard(value)) return value;
      } catch { /* fallback */ }
    }
    return null;
  }
}

export function metadataShardOf(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % SESSION_INDEX_SHARDS).toString(16).padStart(2, "0");
}

function manifestFor(items: readonly ConversationMeta[], generation: number): SessionIndexManifest {
  return {
    schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    generation,
    activeCount: items.filter((item) => !item.isArchived).length,
    archivedCount: items.filter((item) => item.isArchived).length,
    pinnedCount: items.filter((item) => !item.isArchived && item.isPinned).length,
    shardCount: SESSION_INDEX_SHARDS,
    hotRecentLimit: SESSION_HOT_RECENT_LIMIT,
    lastRebuildAt: Date.now(),
  };
}

function buildHot(items: readonly ConversationMeta[], generation: number): SessionIndexShard {
  const active = items.filter((item) => !item.isArchived);
  const pinned = active.filter((item) => item.isPinned).sort(compareActivity);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  const recent = active.filter((item) => !pinnedIds.has(item.id)).sort(compareActivity).slice(0, SESSION_HOT_RECENT_LIMIT);
  return { schemaVersion: SESSION_INDEX_SCHEMA_VERSION, generation, items: [...pinned, ...recent] };
}

function applyManifestTransition(manifest: SessionIndexManifest, previous: ConversationMeta | null, next: ConversationMeta | null): void {
  if (previous) {
    if (previous.isArchived) manifest.archivedCount = Math.max(0, manifest.archivedCount - 1);
    else manifest.activeCount = Math.max(0, manifest.activeCount - 1);
    if (!previous.isArchived && previous.isPinned) manifest.pinnedCount = Math.max(0, manifest.pinnedCount - 1);
  }
  if (next) {
    if (next.isArchived) manifest.archivedCount++;
    else manifest.activeCount++;
    if (!next.isArchived && next.isPinned) manifest.pinnedCount++;
  }
}
function compareActivity(a: ConversationMeta, b: ConversationMeta): number {
  return b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}
function compareMeta(a: ConversationMeta, b: ConversationMeta, by: "activity" | "created"): number {
  const left = by === "activity" ? a.lastActivityAt : a.createdAt;
  const right = by === "activity" ? b.lastActivityAt : b.createdAt;
  return right - left || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}
function isManifest(value: unknown): value is SessionIndexManifest {
  if (!isRecord(value)) return false;
  return value.schemaVersion === SESSION_INDEX_SCHEMA_VERSION
    && finite(value.generation) && finite(value.activeCount) && finite(value.archivedCount) && finite(value.pinnedCount)
    && value.shardCount === SESSION_INDEX_SHARDS && value.hotRecentLimit === SESSION_HOT_RECENT_LIMIT;
}
function isShard(value: unknown): value is SessionIndexShard {
  return isRecord(value) && value.schemaVersion === SESSION_INDEX_SCHEMA_VERSION
    && finite(value.generation) && Array.isArray(value.items) && value.items.every(isConversationMeta);
}
function isConversationMeta(value: unknown): value is ConversationMeta {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.providerId === "string" && typeof value.title === "string"
    && finite(value.createdAt) && finite(value.lastActivityAt) && finite(value.messageCount) && typeof value.preview === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
/** No Node `path` module (mobile-safe) -- vault paths are always "/"-separated. */
function basename(path: string): string { return path.split("/").pop() ?? path; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** Each base filename this store writes, plus its `.tmp`/`.bak` write-ahead variants (see writeJson()/readJson()) -- all normal, none are conflicts. */
function expectedIndexFilenames(bases: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const base of bases) {
    names.add(base);
    names.add(`${base}.tmp`);
    names.add(`${base}.bak`);
  }
  return names;
}
