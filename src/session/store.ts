import type { App } from "obsidian";
import { KeyedSerialQueue, SerialQueue } from "./async-lock";
import { querySessionSummaries } from "./catalog";
import type {
  LegacyChatState,
  PersistedSession,
  SessionCatalog,
  SessionManifest,
  SessionPreferences,
  SessionQuery,
  SessionQueryResult,
  SessionStoreStats,
  SessionSummary,
} from "./types";
import {
  SESSION_CATALOG_SHARDS,
  SESSION_CATALOG_VERSION,
  SESSION_HOT_RECENT_LIMIT,
  SESSION_MANIFEST_VERSION,
  SESSION_SCHEMA_VERSION,
  assertJsonSafe,
  createHistoryId,
  createSessionId,
  deriveSessionPreview,
  deriveSessionTitle,
  summaryOf,
} from "./types";

export interface SessionStoreInitOptions {
  legacyChatStatePaths?: readonly string[];
  defaultPreferences: SessionPreferences;
}

export interface SessionStoreInitResult {
  migratedLegacy: boolean;
  recoveredCatalog: boolean;
  sessionCount: number;
}

export class SessionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Session ${sessionId} changed on disk (expected revision ${expectedRevision}, got ${actualRevision}).`);
  }
}

type PendingCatalogMutation =
  | { schemaVersion: 1; kind: "upsert"; sessionId: string; createdAt: number }
  | { schemaVersion: 1; kind: "delete"; sessionId: string; createdAt: number };

/**
 * Scalable persisted session store.
 *
 * Normal startup reads only manifest.json + hot.json. Full transcripts are always
 * lazy. The complete metadata catalog is split into 64 stable shards, so one
 * session update rewrites one bounded shard instead of a monolithic N-session
 * index. A small hot catalog serves Recent/Pinned without hydrating old metadata.
 *
 * Full-history search / Archive / deep pagination lazily scan metadata shards only
 * (never transcript bodies) and then cache those summaries in memory for the rest
 * of the process. This keeps the common mobile path cheap while retaining exact
 * search over arbitrarily old sessions on demand.
 */
export class SessionStore {
  private readonly root: string;
  private readonly dataDir: string;
  private readonly catalogDir: string;
  private readonly shardDir: string;
  private readonly pendingDir: string;
  private readonly conflictsDir: string;
  private readonly hotCatalogPath: string;
  private readonly manifestPath: string;

  private hotCatalog: SessionCatalog | null = null;
  private manifest: SessionManifest | null = null;
  private readonly shardCache = new Map<string, SessionCatalog>();
  private allSummariesCache: SessionSummary[] | null = null;
  private readonly catalogQueue = new SerialQueue();
  private readonly sessionQueue = new KeyedSerialQueue();

  constructor(
    private readonly app: App,
    pluginId = "chatting-with-ai",
  ) {
    const pluginDir = `${app.vault.configDir}/plugins/${pluginId}`;
    this.root = `${pluginDir}/sessions-v3`;
    this.dataDir = `${this.root}/data`;
    this.catalogDir = `${this.root}/catalog`;
    this.shardDir = `${this.catalogDir}/shards`;
    this.pendingDir = `${this.catalogDir}/pending`;
    this.conflictsDir = `${this.root}/conflicts`;
    this.hotCatalogPath = `${this.catalogDir}/hot.json`;
    this.manifestPath = `${this.root}/manifest.json`;
  }

  async initialize(options: SessionStoreInitOptions): Promise<SessionStoreInitResult> {
    await this.ensureDir(this.dataDir);
    await this.ensureDir(this.catalogDir);
    await this.ensureDir(this.shardDir);
    await this.ensureDir(this.pendingDir);
    await this.ensureDir(this.conflictsDir);

    const manifestRead = await this.readRecoverable(this.manifestPath, isManifest);
    const hotRead = await this.readRecoverable(this.hotCatalogPath, isCatalog);
    this.manifest = manifestRead.value;
    this.hotCatalog = hotRead.value;

    let recoveredCatalog = manifestRead.recovered || hotRead.recovered;
    if (!this.manifest || !this.hotCatalog) {
      await this.rebuildCatalogsFromBodies();
      recoveredCatalog = true;
    } else {
      const repaired = await this.replayPendingMutations();
      recoveredCatalog = recoveredCatalog || repaired;
    }

    let migratedLegacy = false;
    if (!this.manifest?.legacyImportedAt) {
      const legacy = await this.readLegacy(options.legacyChatStatePaths ?? []);
      if (legacy) {
        const imported = this.fromLegacy(legacy, options.defaultPreferences);
        await this.create(imported);
        this.manifest = {
          ...(this.manifest ?? emptyManifest()),
          legacyImportedAt: Date.now(),
        };
        await this.writeManifest();
        migratedLegacy = true;
      }
    }

    const stats = await this.getStats();
    return {
      migratedLegacy,
      recoveredCatalog,
      sessionCount: stats.activeCount + stats.archivedCount,
    };
  }

  async getStats(): Promise<SessionStoreStats> {
    const manifest = await this.getManifest();
    return {
      activeCount: manifest.activeCount,
      archivedCount: manifest.archivedCount,
      pinnedCount: manifest.pinnedCount,
    };
  }

  async create(seed: Omit<PersistedSession, "schemaVersion" | "revision">): Promise<PersistedSession> {
    const session: PersistedSession = {
      ...seed,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: 0,
    };
    return this.save(session, { expectRevision: null });
  }

  async createBlank(preferences: SessionPreferences, title = "New chat"): Promise<PersistedSession> {
    const now = Date.now();
    return this.create({
      id: createSessionId(now),
      title,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      preview: "",
      preferences: { ...preferences },
      isPinned: false,
      isArchived: false,
      hasUnreadActivity: false,
      chatHistory: [],
      agentMessages: [],
      draft: { text: "", contextRefs: [] },
    });
  }

  async load(id: string): Promise<PersistedSession | null> {
    const read = await this.readRecoverable(this.sessionPath(id), isPersistedSession);
    if (!read.value) return null;
    if (read.recovered) {
      await this.writeJsonWithBackup(this.sessionPath(id), read.value);
    }
    return this.normalizeInterrupted(read.value);
  }

  /**
   * Emergency recovery primitive: forces a fresh, uncached read of a
   * session's persisted body straight off disk via the raw vault adapter.
   *
   * This store never caches session bodies in memory (unlike the hot/shard
   * metadata catalogs), so this is currently equivalent to {@link load} —
   * it is kept as a distinct, explicitly-named method so callers (see
   * `SessionRuntime.reloadFromDisk`) express the actual intent ("read
   * whatever is on disk right now, ignore anything already in memory") and
   * so that intent survives even if `load()` ever grows caching later.
   *
   * The file this reads is `sessionPath(id)`, i.e.
   * `sessions-v3/data/<last-2-chars-of-id>/<id>.json` — a single JSON file
   * containing the full session body (chatHistory, agentMessages, draft,
   * etc.), not split across multiple files. This is what a human (or an
   * agent acting on their behalf) hand-edits to trim an oversized tool
   * result before invoking the "Reload" recovery path.
   */
  async reloadFromDisk(id: string): Promise<PersistedSession | null> {
    return this.load(id);
  }

  async save(
    input: PersistedSession,
    options: { expectRevision?: number | null } = {},
  ): Promise<PersistedSession> {
    return this.sessionQueue.run(input.id, async () => {
      const current = await this.loadPrimaryOnly(input.id);
      const expected = options.expectRevision === undefined ? input.revision : options.expectRevision;
      if (current && expected !== null && current.revision !== expected) {
        await this.writeConflictCopy(input);
        throw new SessionConflictError(input.id, expected, current.revision);
      }
      if (!current && expected !== null && expected !== 0) {
        throw new SessionConflictError(input.id, expected, -1);
      }

      const next: PersistedSession = {
        ...input,
        schemaVersion: SESSION_SCHEMA_VERSION,
        revision: current ? current.revision + 1 : Math.max(1, input.revision + 1),
        messageCount: input.chatHistory.length,
        preview: deriveSessionPreview(input.chatHistory),
        title: input.title.trim() || deriveSessionTitle(input.chatHistory),
      };
      assertJsonSafe(next);

      await this.writePending({ schemaVersion: 1, kind: "upsert", sessionId: next.id, createdAt: Date.now() });
      await this.writeJsonWithBackup(this.sessionPath(next.id), next);
      await this.upsertCatalogSummary(summaryOf(next));
      await this.clearPending(next.id);
      return next;
    });
  }

  async query(query: SessionQuery): Promise<SessionQueryResult> {
    const manifest = await this.getManifest();
    const hot = await this.getHotCatalog();
    const normalizedSearch = (query.search ?? "").trim();
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 60)));

    // Common path: Recent/Pinned can be answered exactly from the small hot set.
    if (!normalizedSearch && query.scope !== "archived") {
      const hotResult = querySessionSummaries(hot.sessions, [], { ...query, offset, limit });
      const total = query.scope === "pinned" ? manifest.pinnedCount : manifest.activeCount;
      const hotCoverage = query.scope === "pinned"
        ? hot.sessions.filter((item) => item.isPinned && !item.isArchived).length
        : hot.sessions.filter((item) => !item.isArchived).length;
      const requiredCoverage = Math.min(total, offset + limit);
      if (hotCoverage >= requiredCoverage || requiredCoverage === total) {
        return {
          ...hotResult,
          total,
          nextOffset: offset + hotResult.items.length < total
            ? offset + hotResult.items.length
            : null,
        };
      }
    }

    // Archive, search, or deep pagination: hydrate metadata shards only.
    const all = await this.getAllSummaries();
    const active = all.filter((item) => !item.isArchived);
    const archived = all.filter((item) => item.isArchived);
    return querySessionSummaries(active, archived, { ...query, offset, limit });
  }

  async getSummary(id: string): Promise<SessionSummary | null> {
    const hot = (await this.getHotCatalog()).sessions.find((item) => item.id === id);
    if (hot) return hot;
    const shard = await this.getMetadataShard(metadataShardOf(id));
    return shard.sessions.find((item) => item.id === id) ?? null;
  }

  async rename(id: string, title: string): Promise<PersistedSession | null> {
    return this.updateSession(id, (session) => ({ ...session, title: title.trim() || session.title }));
  }

  async setPinned(id: string, pinned: boolean): Promise<PersistedSession | null> {
    return this.updateSession(id, (session) => ({ ...session, isPinned: pinned && !session.isArchived }));
  }

  async setArchived(id: string, archived: boolean): Promise<PersistedSession | null> {
    return this.updateSession(id, (session) => ({
      ...session,
      isArchived: archived,
      isPinned: archived ? false : session.isPinned,
      hasUnreadActivity: archived ? false : session.hasUnreadActivity,
    }));
  }

  async setUnread(id: string, unread: boolean): Promise<PersistedSession | null> {
    return this.updateSession(id, (session) => ({ ...session, hasUnreadActivity: unread }));
  }

  async updatePreferences(id: string, preferences: SessionPreferences): Promise<PersistedSession | null> {
    return this.updateSession(id, (session) => ({ ...session, preferences: { ...preferences } }));
  }

  async fork(id: string): Promise<PersistedSession | null> {
    const source = await this.load(id);
    if (!source) return null;
    const now = Date.now();
    const history = [...source.chatHistory];
    const agentMessages = [...source.agentMessages];
    return this.create({
      ...source,
      id: createSessionId(now),
      title: `${source.title} (fork)`,
      createdAt: now,
      lastActivityAt: now,
      messageCount: history.length,
      preview: deriveSessionPreview(history),
      isPinned: false,
      isArchived: false,
      hasUnreadActivity: false,
      forkedFrom: { sessionId: source.id },
      chatHistory: history,
      agentMessages,
      draft: { text: "", contextRefs: [] },
      recovery: undefined,
      lastOutcome: undefined,
      lastError: undefined,
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.sessionQueue.run(id, async () => {
      const summary = await this.getSummary(id);
      const path = this.sessionPath(id);
      const existed = await this.app.vault.adapter.exists(path) || !!summary;
      if (!existed) return false;

      await this.writePending({ schemaVersion: 1, kind: "delete", sessionId: id, createdAt: Date.now() });
      try {
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
        if (await this.app.vault.adapter.exists(`${path}.bak`)) await this.app.vault.adapter.remove(`${path}.bak`);
      } catch {
        // Leave the pending marker. Startup repair will reconcile the catalog.
        return false;
      }
      await this.removeCatalogSummary(id);
      await this.clearPending(id);
      return true;
    });
  }

  /**
   * Exceptional recovery path. Scans full session bodies, recreates metadata
   * shards and the hot catalog, and recomputes manifest counts.
   */
  async rebuildCatalogsFromBodies(): Promise<void> {
    const summaries: SessionSummary[] = [];
    await this.walkSessionFiles(this.dataDir, async (path) => {
      const read = await this.readRecoverable(path, isPersistedSession);
      if (read.value) summaries.push(summaryOf(this.normalizeInterrupted(read.value)));
    });

    await this.clearCatalogShardFiles();
    this.shardCache.clear();
    const grouped = new Map<string, SessionSummary[]>();
    for (const summary of summaries) {
      const key = metadataShardOf(summary.id);
      const group = grouped.get(key) ?? [];
      group.push(summary);
      grouped.set(key, group);
    }

    const generation = (this.manifest?.generation ?? 0) + 1;
    for (const [key, sessions] of grouped) {
      const shard: SessionCatalog = { schemaVersion: SESSION_CATALOG_VERSION, generation, sessions };
      this.shardCache.set(key, shard);
      await this.writeJsonWithBackup(this.metadataShardPath(key), shard);
    }

    this.hotCatalog = buildHotCatalog(summaries, generation);
    await this.writeJsonWithBackup(this.hotCatalogPath, this.hotCatalog);
    this.manifest = manifestForSummaries(summaries, generation, {
      legacyImportedAt: this.manifest?.legacyImportedAt,
      lastRebuildAt: Date.now(),
    });
    await this.writeManifest();
    this.allSummariesCache = summaries;
  }

  /** Optional idle maintenance. Safe to call after startup or when the rail opens. */
  async refillHotCatalogIfNeeded(): Promise<boolean> {
    const manifest = await this.getManifest();
    if (!manifest.hotNeedsRefill) return false;
    return this.catalogQueue.run(async () => {
      const current = await this.getManifest();
      if (!current.hotNeedsRefill) return false;
      const all = await this.getAllSummaries();
      const nextGeneration = current.generation + 1;
      this.hotCatalog = buildHotCatalog(all, nextGeneration);
      await this.writeJsonWithBackup(this.hotCatalogPath, this.hotCatalog);
      current.generation = nextGeneration;
      current.hotNeedsRefill = false;
      await this.writeManifest();
      return true;
    });
  }

  private async updateSession(
    id: string,
    updater: (session: PersistedSession) => PersistedSession,
  ): Promise<PersistedSession | null> {
    const session = await this.load(id);
    if (!session) return null;
    return this.save(updater(session), { expectRevision: session.revision });
  }

  private async upsertCatalogSummary(summary: SessionSummary): Promise<void> {
    await this.catalogQueue.run(async () => {
      const manifest = await this.getManifest();
      const hot = await this.getHotCatalog();
      const key = metadataShardOf(summary.id);
      const shard = await this.getMetadataShard(key);
      const previous = shard.sessions.find((item) => item.id === summary.id) ?? null;
      const nextGeneration = manifest.generation + 1;

      shard.sessions = [summary, ...shard.sessions.filter((item) => item.id !== summary.id)];
      shard.generation = nextGeneration;
      await this.writeJsonWithBackup(this.metadataShardPath(key), shard);

      applyManifestTransition(manifest, previous, summary);
      manifest.generation = nextGeneration;
      updateHotCatalog(hot, summary, previous, nextGeneration, manifest);
      await this.writeJsonWithBackup(this.hotCatalogPath, hot);
      await this.writeManifest();
      this.updateAllSummariesCache(summary, false);
    });
  }

  private async removeCatalogSummary(id: string): Promise<void> {
    await this.catalogQueue.run(async () => {
      const manifest = await this.getManifest();
      const hot = await this.getHotCatalog();
      const key = metadataShardOf(id);
      const shard = await this.getMetadataShard(key);
      const previous = shard.sessions.find((item) => item.id === id) ?? null;
      if (!previous) return;
      const nextGeneration = manifest.generation + 1;

      shard.sessions = shard.sessions.filter((item) => item.id !== id);
      shard.generation = nextGeneration;
      await this.writeJsonWithBackup(this.metadataShardPath(key), shard);

      applyManifestTransition(manifest, previous, null);
      manifest.generation = nextGeneration;
      const wasHot = hot.sessions.some((item) => item.id === id);
      hot.sessions = hot.sessions.filter((item) => item.id !== id);
      hot.generation = nextGeneration;
      if (wasHot && manifest.activeCount > hot.sessions.filter((item) => !item.isArchived).length) {
        manifest.hotNeedsRefill = true;
      }
      await this.writeJsonWithBackup(this.hotCatalogPath, hot);
      await this.writeManifest();
      this.updateAllSummariesCache(previous, true);
    });
  }

  private async getManifest(): Promise<SessionManifest> {
    if (this.manifest) return this.manifest;
    const read = await this.readRecoverable(this.manifestPath, isManifest);
    this.manifest = read.value ?? emptyManifest();
    return this.manifest;
  }

  private async getHotCatalog(): Promise<SessionCatalog> {
    if (this.hotCatalog) return this.hotCatalog;
    const read = await this.readRecoverable(this.hotCatalogPath, isCatalog);
    this.hotCatalog = read.value ?? emptyCatalog();
    return this.hotCatalog;
  }

  private async getMetadataShard(key: string): Promise<SessionCatalog> {
    const cached = this.shardCache.get(key);
    if (cached) return cached;
    const read = await this.readRecoverable(this.metadataShardPath(key), isCatalog);
    const shard = read.value ?? emptyCatalog();
    this.shardCache.set(key, shard);
    return shard;
  }

  private async getAllSummaries(): Promise<SessionSummary[]> {
    if (this.allSummariesCache) return this.allSummariesCache;
    const all: SessionSummary[] = [];
    for (let i = 0; i < SESSION_CATALOG_SHARDS; i++) {
      const key = i.toString(16).padStart(2, "0");
      const shard = await this.getMetadataShard(key);
      all.push(...shard.sessions);
    }
    this.allSummariesCache = all;
    return all;
  }

  private updateAllSummariesCache(summary: SessionSummary, remove: boolean): void {
    if (!this.allSummariesCache) return;
    this.allSummariesCache = this.allSummariesCache.filter((item) => item.id !== summary.id);
    if (!remove) this.allSummariesCache.push(summary);
  }

  private fromLegacy(legacy: LegacyChatState, preferences: SessionPreferences): Omit<PersistedSession, "schemaVersion" | "revision"> {
    const now = Date.now();
    const chatHistory = (legacy.chatHistory ?? []).map((entry, index) => ({
      id: typeof entry.id === "string" ? entry.id : createHistoryId(now + index),
      type: entry.type,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : now + index,
      text: entry.text,
      contextRefs: entry.contextRefs,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      toolResult: entry.toolResult,
    }));
    return {
      id: createSessionId(now),
      title: deriveSessionTitle(chatHistory),
      createdAt: now,
      lastActivityAt: now,
      messageCount: chatHistory.length,
      preview: deriveSessionPreview(chatHistory),
      preferences: { ...preferences },
      isPinned: false,
      isArchived: false,
      hasUnreadActivity: false,
      chatHistory,
      agentMessages: legacy.agentMessages ?? [],
      draft: { text: "", contextRefs: [] },
    };
  }

  private normalizeInterrupted(session: PersistedSession): PersistedSession {
    if (!session.recovery) return session;
    return {
      ...session,
      recovery: undefined,
      lastOutcome: "interrupted",
      lastError: session.recovery.phase === "waiting_user"
        ? "The previous run was interrupted while waiting for input."
        : "The previous run was interrupted before completion.",
    };
  }

  private async loadPrimaryOnly(id: string): Promise<PersistedSession | null> {
    try {
      const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(this.sessionPath(id)));
      return isPersistedSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async readLegacy(paths: readonly string[]): Promise<LegacyChatState | null> {
    for (const path of paths) {
      try {
        const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(path));
        if (isLegacyChatState(parsed)) return parsed;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private async writePending(mutation: PendingCatalogMutation): Promise<void> {
    await this.writeJsonWithBackup(this.pendingPath(mutation.sessionId), mutation);
  }

  private async clearPending(sessionId: string): Promise<void> {
    for (const suffix of ["", ".tmp", ".bak"]) {
      const path = `${this.pendingPath(sessionId)}${suffix}`;
      try { if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path); } catch { /* best effort */ }
    }
  }

  private async replayPendingMutations(): Promise<boolean> {
    let repaired = false;
    let listed: { files: string[]; folders: string[] };
    try { listed = await this.app.vault.adapter.list(this.pendingDir); } catch { return false; }
    for (const path of listed.files) {
      if (!path.endsWith(".json")) continue;
      const read = await this.readRecoverable(path, isPendingMutation);
      const mutation = read.value;
      if (!mutation) continue;
      if (mutation.kind === "delete") {
        await this.removeCatalogSummary(mutation.sessionId);
      } else {
        const body = await this.load(mutation.sessionId);
        if (body) await this.upsertCatalogSummary(summaryOf(body));
        else await this.removeCatalogSummary(mutation.sessionId);
      }
      await this.clearPending(mutation.sessionId);
      repaired = true;
    }
    return repaired;
  }

  private sessionPath(id: string): string {
    const shard = bodyShardOf(id);
    return `${this.dataDir}/${shard}/${id}.json`;
  }

  /**
   * Public accessor for the exact path of a session's editable body file,
   * for recovery tooling/tests. Mirrors {@link sessionPath} exactly (single
   * file, not sharded further) — see {@link reloadFromDisk}.
   */
  pathForSessionBody(id: string): string {
    return this.sessionPath(id);
  }

  private metadataShardPath(key: string): string {
    return `${this.shardDir}/${key}.json`;
  }

  private pendingPath(id: string): string {
    return `${this.pendingDir}/${id}.json`;
  }

  private async writeConflictCopy(session: PersistedSession): Promise<void> {
    const path = `${this.conflictsDir}/${session.id}-${Date.now()}.json`;
    await this.writeJsonWithBackup(path, session);
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) return;
    await this.writeJsonWithBackup(this.manifestPath, this.manifest);
  }

  private async writeJsonWithBackup(path: string, value: unknown): Promise<void> {
    assertJsonSafe(value);
    await this.ensureParent(path);
    const tmp = `${path}.tmp`;
    const bak = `${path}.bak`;
    const serialized = JSON.stringify(value);
    await this.app.vault.adapter.write(tmp, serialized);
    JSON.parse(await this.app.vault.adapter.read(tmp));

    try {
      if (await this.app.vault.adapter.exists(path)) {
        if (await this.app.vault.adapter.exists(bak)) await this.app.vault.adapter.remove(bak);
        await this.app.vault.adapter.rename(path, bak);
      }
      await this.app.vault.adapter.rename(tmp, path);
    } catch (error) {
      // Some mobile adapters are conservative around rename. Fall back to write.
      await this.app.vault.adapter.write(path, serialized);
      try { if (await this.app.vault.adapter.exists(tmp)) await this.app.vault.adapter.remove(tmp); } catch { /* best effort */ }
      if (error instanceof Error && !serialized) throw error;
    }
  }

  private async readRecoverable<T>(
    path: string,
    guard: (value: unknown) => value is T,
  ): Promise<{ value: T | null; recovered: boolean }> {
    const candidates = [path, `${path}.tmp`, `${path}.bak`];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(candidates[i]));
        if (guard(parsed)) return { value: parsed, recovered: i > 0 };
      } catch {
        // Continue to fallback.
      }
    }
    return { value: null, recovered: false };
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDir(parent);
  }

  private async ensureDir(path: string): Promise<void> {
    if (!path || await this.app.vault.adapter.exists(path)) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDir(parent);
    try { await this.app.vault.adapter.mkdir(path); } catch { /* another path may have created it */ }
  }

  private async walkSessionFiles(path: string, visit: (path: string) => Promise<void>): Promise<void> {
    try {
      const listed = await this.app.vault.adapter.list(path);
      for (const file of listed.files) {
        if (/\/s_[a-z0-9_]+\.json$/i.test(file)) await visit(file);
      }
      for (const folder of listed.folders) await this.walkSessionFiles(folder, visit);
    } catch {
      // A damaged shard should not prevent the rest from rebuilding.
    }
  }

  private async clearCatalogShardFiles(): Promise<void> {
    try {
      const listed = await this.app.vault.adapter.list(this.shardDir);
      for (const file of listed.files) {
        try { await this.app.vault.adapter.remove(file); } catch { /* best effort */ }
      }
    } catch { /* no shards yet */ }
  }
}

function bodyShardOf(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, "").slice(-2).toLowerCase();
  return tail.padStart(2, "0");
}

/** Stable FNV-1a hash -> 64 metadata shards. */
export function metadataShardOf(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % SESSION_CATALOG_SHARDS).toString(16).padStart(2, "0");
}

function emptyCatalog(): SessionCatalog {
  return { schemaVersion: SESSION_CATALOG_VERSION, generation: 0, sessions: [] };
}

function emptyManifest(): SessionManifest {
  return {
    schemaVersion: SESSION_MANIFEST_VERSION,
    generation: 0,
    activeCount: 0,
    archivedCount: 0,
    pinnedCount: 0,
    shardCount: SESSION_CATALOG_SHARDS,
    hotRecentLimit: SESSION_HOT_RECENT_LIMIT,
  };
}

function manifestForSummaries(
  summaries: readonly SessionSummary[],
  generation: number,
  preserved: Pick<SessionManifest, "legacyImportedAt" | "lastRebuildAt">,
): SessionManifest {
  return {
    ...emptyManifest(),
    generation,
    activeCount: summaries.filter((item) => !item.isArchived).length,
    archivedCount: summaries.filter((item) => item.isArchived).length,
    pinnedCount: summaries.filter((item) => !item.isArchived && item.isPinned).length,
    legacyImportedAt: preserved.legacyImportedAt,
    lastRebuildAt: preserved.lastRebuildAt,
  };
}

function buildHotCatalog(summaries: readonly SessionSummary[], generation: number): SessionCatalog {
  const active = summaries.filter((item) => !item.isArchived);
  const pinned = active.filter((item) => item.isPinned).sort(compareActivity);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  const recent = active
    .filter((item) => !pinnedIds.has(item.id))
    .sort(compareActivity)
    .slice(0, SESSION_HOT_RECENT_LIMIT);
  return { schemaVersion: SESSION_CATALOG_VERSION, generation, sessions: [...pinned, ...recent] };
}

function updateHotCatalog(
  hot: SessionCatalog,
  summary: SessionSummary,
  previous: SessionSummary | null,
  generation: number,
  manifest: SessionManifest,
): void {
  const wasHot = hot.sessions.some((item) => item.id === summary.id);
  hot.sessions = hot.sessions.filter((item) => item.id !== summary.id);
  if (!summary.isArchived) hot.sessions.push(summary);

  const pinned = hot.sessions.filter((item) => !item.isArchived && item.isPinned).sort(compareActivity);
  const pinnedIds = new Set(pinned.map((item) => item.id));
  const recent = hot.sessions
    .filter((item) => !item.isArchived && !pinnedIds.has(item.id))
    .sort(compareActivity)
    .slice(0, SESSION_HOT_RECENT_LIMIT);
  hot.sessions = [...pinned, ...recent];
  hot.generation = generation;

  if (wasHot && summary.isArchived && manifest.activeCount > hot.sessions.length) {
    manifest.hotNeedsRefill = true;
  }
  if (previous?.isPinned && !summary.isPinned && manifest.activeCount > hot.sessions.length) {
    manifest.hotNeedsRefill = true;
  }
}

function compareActivity(left: SessionSummary, right: SessionSummary): number {
  return right.lastActivityAt - left.lastActivityAt
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id);
}

function applyManifestTransition(
  manifest: SessionManifest,
  previous: SessionSummary | null,
  next: SessionSummary | null,
): void {
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

function isManifest(value: unknown): value is SessionManifest {
  return isRecord(value)
    && value.schemaVersion === SESSION_MANIFEST_VERSION
    && finite(value.generation)
    && finite(value.activeCount)
    && finite(value.archivedCount)
    && finite(value.pinnedCount)
    && value.shardCount === SESSION_CATALOG_SHARDS
    && value.hotRecentLimit === SESSION_HOT_RECENT_LIMIT;
}

function isCatalog(value: unknown): value is SessionCatalog {
  return isRecord(value)
    && value.schemaVersion === SESSION_CATALOG_VERSION
    && finite(value.generation)
    && Array.isArray(value.sessions)
    && value.sessions.every(isSummary);
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION || !isSummary(value)) return false;
  const record = value as Record<string, any>;
  return Array.isArray(record.chatHistory)
    && Array.isArray(record.agentMessages)
    && isRecord(record.draft)
    && typeof record.draft.text === "string"
    && Array.isArray(record.draft.contextRefs);
}

function isSummary(value: unknown): value is SessionSummary {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && finite(value.revision)
    && typeof value.title === "string"
    && finite(value.createdAt)
    && finite(value.lastActivityAt)
    && finite(value.messageCount)
    && typeof value.preview === "string"
    && isPreferences(value.preferences)
    && typeof value.isPinned === "boolean"
    && typeof value.isArchived === "boolean"
    && typeof value.hasUnreadActivity === "boolean";
}

function isPreferences(value: unknown): value is SessionPreferences {
  return isRecord(value)
    && (value.provider === "anthropic" || value.provider === "openai" || value.provider === "chatgpt-oauth")
    && typeof value.model === "string";
}

function isLegacyChatState(value: unknown): value is LegacyChatState {
  return isRecord(value)
    && (Array.isArray(value.chatHistory) || Array.isArray(value.agentMessages));
}

function isPendingMutation(value: unknown): value is PendingCatalogMutation {
  return isRecord(value)
    && value.schemaVersion === 1
    && (value.kind === "upsert" || value.kind === "delete")
    && typeof value.sessionId === "string"
    && finite(value.createdAt);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
