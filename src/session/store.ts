import { App } from "obsidian";
import type {
  LegacyChatState,
  PersistedSession,
  SessionIndex,
  SessionMetadata,
} from "./types";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  assertJsonSafe,
  createSessionId,
  deriveSessionTitle,
  isLegacyChatState,
  isPersistedSession,
  isSessionIndex,
} from "./types";

export interface SessionStoreBootstrap {
  index: SessionIndex;
  session: PersistedSession;
  migratedLegacyState: boolean;
  recovered: boolean;
}

export interface InitializeSessionStoreOptions {
  legacyChatStatePaths?: string[];
}

export class SessionStore {
  private readonly pluginDataDir: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(
    private readonly app: App,
    pluginId = "chatting-with-ai",
  ) {
    this.pluginDataDir = `${app.vault.configDir}/plugins/${pluginId}`;
    this.sessionsDir = `${this.pluginDataDir}/sessions`;
    this.indexPath = `${this.sessionsDir}/index.json`;
  }

  async initialize(options: InitializeSessionStoreOptions = {}): Promise<SessionStoreBootstrap> {
    await this.ensureDir(this.sessionsDir);

    const existing = await this.readRecoverableJson(this.indexPath, isSessionIndex);
    let index = existing.value;
    let migratedLegacyState = false;
    let recovered = existing.recovered;

    if (!index) {
      const legacy = await this.readFirstLegacy(options.legacyChatStatePaths ?? []);
      const session = legacy
        ? this.sessionFromLegacy(legacy)
        : this.blankSession();
      await this.writeSessionFile(session);
      index = this.indexFor([session], session.id);
      await this.writeJsonWithBackup(this.indexPath, index);
      migratedLegacyState = !!legacy;
      return { index, session, migratedLegacyState, recovered };
    }

    const reconciled = await this.reconcile(index);
    index = reconciled.index;
    recovered = recovered || reconciled.recovered;

    let active = index.activeSessionId ? await this.load(index.activeSessionId) : null;
    if (!active) {
      const fallbackId = index.sessions[0]?.id;
      active = fallbackId ? await this.load(fallbackId) : null;
    }

    if (!active) {
      active = this.blankSession();
      await this.writeSessionFile(active);
      index = this.indexFor([active], active.id);
      await this.writeJsonWithBackup(this.indexPath, index);
    } else if (index.activeSessionId !== active.id) {
      index = { ...index, activeSessionId: active.id };
      await this.writeJsonWithBackup(this.indexPath, index);
    }

    return { index, session: active, migratedLegacyState, recovered };
  }

  async list(): Promise<SessionMetadata[]> {
    const index = await this.requireIndex();
    return [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getActiveId(): Promise<string | null> {
    return (await this.requireIndex()).activeSessionId;
  }

  async load(id: string): Promise<PersistedSession | null> {
    if (!safeSessionId(id)) return null;
    const loaded = await this.readRecoverableJson(this.sessionPath(id), isPersistedSession);
    return loaded.value;
  }

  async create(title = "New chat"): Promise<PersistedSession> {
    const session = this.blankSession(title);
    await this.writeSessionFile(session);

    const index = await this.requireIndex();
    const next = this.upsertMetadata(index, session, true);
    await this.writeJsonWithBackup(this.indexPath, next);
    return session;
  }

  async save(session: PersistedSession): Promise<PersistedSession> {
    const now = Date.now();
    const next: PersistedSession = {
      ...session,
      schemaVersion: SESSION_SCHEMA_VERSION,
      title: session.title.trim() || deriveSessionTitle(session.chatHistory),
      updatedAt: Math.max(now, session.createdAt),
      chatHistory: [...session.chatHistory],
      agentMessages: [...session.agentMessages],
    };
    assertJsonSafe(next);
    await this.writeSessionFile(next);

    const index = await this.requireIndex();
    const nextIndex = this.upsertMetadata(index, next, index.activeSessionId === next.id);
    await this.writeJsonWithBackup(this.indexPath, nextIndex);
    return next;
  }

  async rename(id: string, titleRaw: string): Promise<PersistedSession | null> {
    const session = await this.load(id);
    if (!session) return null;
    const title = titleRaw.replace(/\s+/g, " ").trim().slice(0, 120);
    return this.save({ ...session, title: title || "New chat" });
  }

  async setActive(id: string): Promise<void> {
    const session = await this.load(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    const index = await this.requireIndex();
    const next = this.upsertMetadata(index, session, true);
    await this.writeJsonWithBackup(this.indexPath, next);
  }

  async remove(id: string): Promise<{ index: SessionIndex; replacement: PersistedSession | null }> {
    if (!safeSessionId(id)) throw new Error(`Invalid session id: ${id}`);
    let index = await this.requireIndex();

    await this.removeIfExists(this.sessionPath(id));
    await this.removeIfExists(`${this.sessionPath(id)}.tmp`);
    await this.removeIfExists(`${this.sessionPath(id)}.bak`);

    const remaining = index.sessions.filter((item) => item.id !== id);
    let replacement: PersistedSession | null = null;

    if (remaining.length === 0) {
      replacement = this.blankSession();
      await this.writeSessionFile(replacement);
      index = this.indexFor([replacement], replacement.id);
    } else {
      let activeSessionId = index.activeSessionId;
      if (!activeSessionId || activeSessionId === id || !remaining.some((item) => item.id === activeSessionId)) {
        activeSessionId = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
      }
      index = {
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        activeSessionId,
        sessions: [...remaining].sort((a, b) => b.updatedAt - a.updatedAt),
      };
      if (activeSessionId !== id) replacement = await this.load(activeSessionId);
    }

    await this.writeJsonWithBackup(this.indexPath, index);
    return { index, replacement };
  }

  private async requireIndex(): Promise<SessionIndex> {
    const loaded = await this.readRecoverableJson(this.indexPath, isSessionIndex);
    if (loaded.value) return loaded.value;
    const bootstrap = await this.initialize();
    return bootstrap.index;
  }

  private async reconcile(input: SessionIndex): Promise<{ index: SessionIndex; recovered: boolean }> {
    const known = new Map<string, SessionMetadata>();
    let recovered = false;

    for (const meta of input.sessions) {
      const session = await this.load(meta.id);
      if (session) known.set(session.id, metadataOf(session));
      else recovered = true;
    }

    try {
      const listed = await this.app.vault.adapter.list(this.sessionsDir);
      for (const path of listed.files) {
        const name = path.split("/").pop() ?? "";
        const match = name.match(/^(s_[a-z0-9_]+)\.json$/i);
        if (!match || known.has(match[1])) continue;
        const session = await this.load(match[1]);
        if (session) {
          known.set(session.id, metadataOf(session));
          recovered = true;
        }
      }
    } catch {
      // If listing itself fails, keep the validated index entries.
    }

    const sessions = [...known.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const activeSessionId = input.activeSessionId && known.has(input.activeSessionId)
      ? input.activeSessionId
      : sessions[0]?.id ?? null;

    const next: SessionIndex = {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      activeSessionId,
      sessions,
    };

    if (recovered || JSON.stringify(next) !== JSON.stringify(input)) {
      await this.writeJsonWithBackup(this.indexPath, next);
    }
    return { index: next, recovered };
  }

  private sessionFromLegacy(legacy: LegacyChatState): PersistedSession {
    const now = Date.now();
    const chatHistory = legacy.chatHistory ?? [];
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: createSessionId(now),
      title: deriveSessionTitle(chatHistory),
      createdAt: now,
      updatedAt: now,
      chatHistory,
      agentMessages: legacy.agentMessages ?? [],
    };
  }

  private blankSession(title = "New chat"): PersistedSession {
    const now = Date.now();
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: createSessionId(now),
      title,
      createdAt: now,
      updatedAt: now,
      chatHistory: [],
      agentMessages: [],
    };
  }

  private indexFor(sessions: readonly PersistedSession[], activeSessionId: string | null): SessionIndex {
    return {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      activeSessionId,
      sessions: sessions.map(metadataOf).sort((a, b) => b.updatedAt - a.updatedAt),
    };
  }

  private upsertMetadata(index: SessionIndex, session: PersistedSession, makeActive: boolean): SessionIndex {
    const metadata = metadataOf(session);
    const sessions = [metadata, ...index.sessions.filter((item) => item.id !== session.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      activeSessionId: makeActive ? session.id : index.activeSessionId,
      sessions,
    };
  }

  private async readFirstLegacy(paths: readonly string[]): Promise<LegacyChatState | null> {
    for (const path of paths) {
      if (!path) continue;
      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed: unknown = JSON.parse(raw);
        if (isLegacyChatState(parsed)) return parsed;
      } catch {
        // Try the next legacy candidate. Legacy corruption must not block startup.
      }
    }
    return null;
  }

  private async writeSessionFile(session: PersistedSession): Promise<void> {
    assertJsonSafe(session);
    await this.writeJsonWithBackup(this.sessionPath(session.id), session);
  }

  private async readRecoverableJson<T>(
    path: string,
    guard: (value: unknown) => value is T,
  ): Promise<{ value: T | null; recovered: boolean }> {
    const candidates = [path, `${path}.tmp`, `${path}.bak`];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const raw = await this.app.vault.adapter.read(candidates[i]);
        const parsed: unknown = JSON.parse(raw);
        if (guard(parsed)) return { value: parsed, recovered: i > 0 };
      } catch {
        // continue
      }
    }
    return { value: null, recovered: false };
  }

  private async writeJsonWithBackup(path: string, value: unknown): Promise<void> {
    assertJsonSafe(value);
    const serialized = JSON.stringify(value, null, 2);
    const tmp = `${path}.tmp`;
    const bak = `${path}.bak`;
    await this.ensureParent(path);

    await this.app.vault.adapter.write(tmp, serialized);
    // Verify the just-written temp file before rotating the primary.
    JSON.parse(await this.app.vault.adapter.read(tmp));

    if (await this.app.vault.adapter.exists(bak)) {
      await this.app.vault.adapter.remove(bak);
    }
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.rename(path, bak);
    }

    try {
      await this.app.vault.adapter.rename(tmp, path);
    } catch (error) {
      // Best-effort restoration of the previous good primary.
      if (!(await this.app.vault.adapter.exists(path)) && await this.app.vault.adapter.exists(bak)) {
        try { await this.app.vault.adapter.rename(bak, path); } catch { /* preserve original error */ }
      }
      throw error;
    }
  }

  private sessionPath(id: string): string {
    if (!safeSessionId(id)) throw new Error(`Invalid session id: ${id}`);
    return `${this.sessionsDir}/${id}.json`;
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDir(parent);
  }

  private async ensureDir(path: string): Promise<void> {
    if (await this.app.vault.adapter.exists(path)) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureDir(parent);
    try { await this.app.vault.adapter.mkdir(path); } catch { /* race-safe */ }
  }

  private async removeIfExists(path: string): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
    } catch {
      // Deletion cleanup is best-effort; reconciliation handles stale metadata.
    }
  }
}

function metadataOf(session: PersistedSession): SessionMetadata {
  const { id, title, createdAt, updatedAt, profileId, effortOverride } = session;
  return { id, title, createdAt, updatedAt, profileId, effortOverride };
}

function safeSessionId(value: string): boolean {
  return /^s_[a-z0-9_]+$/i.test(value);
}
