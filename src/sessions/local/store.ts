import type { ContextRef } from "../../context/refs";
import type { SessionStorageAdapter } from "../storage-adapter";
import type { SessionLocalState } from "../runtime/types";
import { assertValidSessionMetadataId } from "../metadata/codec";

export const DEFAULT_SESSION_LOCAL_STATE_ROOT = ".chatting/session-state";

export function createDefaultSessionLocalState(sessionId: string): SessionLocalState {
  return {
    schemaVersion: 1,
    sessionId,
    draft: { text: "", contextRefs: [] },
    hasUnreadActivity: false,
  };
}

export class SessionLocalStateStore {
  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly root = DEFAULT_SESSION_LOCAL_STATE_ROOT,
  ) {}

  pathFor(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.root}/${id}.json`;
  }

  async load(id: string): Promise<SessionLocalState> {
    const path = this.pathFor(id);
    for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
      try {
        if (!await this.adapter.exists(candidate)) continue;
        const parsed = JSON.parse(await this.adapter.read(candidate)) as unknown;
        const normalized = normalizeLocalState(parsed, id);
        if (normalized) return normalized;
      } catch {
        // Try next recovery candidate.
      }
    }
    return createDefaultSessionLocalState(id);
  }

  async save(state: SessionLocalState): Promise<void> {
    const normalized = normalizeLocalState(state, state.sessionId);
    if (!normalized) throw new Error(`Invalid local session state: ${state.sessionId}`);
    await this.adapter.ensureFolder(this.root);
    await writeJsonSafely(this.adapter, this.pathFor(state.sessionId), normalized);
  }

  async remove(id: string): Promise<void> {
    const path = this.pathFor(id);
    for (const candidate of [path, `${path}.tmp`, `${path}.bak`]) {
      if (await this.adapter.exists(candidate)) await this.adapter.remove(candidate);
    }
  }
}

function normalizeLocalState(value: unknown, expectedId: string): SessionLocalState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1 || value.sessionId !== expectedId) return null;
  if (!isRecord(value.draft) || typeof value.draft.text !== "string") return null;
  if (!Array.isArray(value.draft.contextRefs) || !value.draft.contextRefs.every(isContextRef)) return null;
  if (typeof value.hasUnreadActivity !== "boolean") return null;
  if (value.lastOutcome !== undefined && !["completed", "stopped", "error", "interrupted"].includes(String(value.lastOutcome))) return null;
  if (value.lastError !== undefined && typeof value.lastError !== "string") return null;
  if (value.recovery !== undefined && !isRecovery(value.recovery)) return null;
  return {
    schemaVersion: 1,
    sessionId: expectedId,
    draft: {
      text: value.draft.text,
      contextRefs: [...value.draft.contextRefs] as ContextRef[],
    },
    hasUnreadActivity: value.hasUnreadActivity,
    ...(typeof value.lastOutcome === "string" ? { lastOutcome: value.lastOutcome as SessionLocalState["lastOutcome"] } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError.slice(0, 1000) } : {}),
    ...(value.recovery ? { recovery: value.recovery as SessionLocalState["recovery"] } : {}),
  };
}

function isRecovery(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.phase !== "running" && value.phase !== "waiting_user") return false;
  if (!finite(value.startedAt) || !finite(value.updatedAt)) return false;
  if (value.pendingQuestion !== undefined && typeof value.pendingQuestion !== "string") return false;
  if (value.pendingInput !== undefined) {
    if (!isRecord(value.pendingInput) || typeof value.pendingInput.text !== "string") return false;
    if (value.pendingInput.contextRefs !== undefined && (!Array.isArray(value.pendingInput.contextRefs) || !value.pendingInput.contextRefs.every(isContextRef))) return false;
  }
  return true;
}

function isContextRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.kind === "pdf" || value.kind === "image")
    && typeof value.id === "string"
    && typeof value.path === "string"
    && typeof value.name === "string"
    && typeof value.mime === "string"
    && finite(value.size)
    && finite(value.mtime);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function writeJsonSafely(adapter: SessionStorageAdapter, path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  JSON.parse(serialized);
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  await adapter.write(tmp, serialized);
  if (await adapter.exists(path)) {
    if (await adapter.exists(bak)) await adapter.remove(bak);
    await adapter.rename(path, bak);
  }
  await adapter.rename(tmp, path);
}
