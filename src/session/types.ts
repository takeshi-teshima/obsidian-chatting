import type { UnifiedMessage, ToolResult, Provider, SelectionScope } from "../types";
import type { ContextRef } from "../context/refs";
import type { ReasoningEffort } from "../model/reasoning";

export const SESSION_SCHEMA_VERSION = 3 as const;
export const SESSION_CATALOG_VERSION = 4 as const;
export const SESSION_MANIFEST_VERSION = 4 as const;
export const SESSION_CATALOG_SHARDS = 64 as const;
export const SESSION_HOT_RECENT_LIMIT = 512 as const;

export type SessionRunPhase =
  | "idle"
  | "queued"
  | "running"
  | "waiting_user"
  | "stopping";

export type SessionRunOutcome =
  | "completed"
  | "stopped"
  | "error"
  | "interrupted";

export interface ChatHistoryEntry {
  id: string;
  type: "user" | "assistant" | "tool-result" | "error";
  timestamp: number;
  text?: string;
  contextRefs?: ContextRef[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
}

export interface SessionDraft {
  text: string;
  contextRefs: ContextRef[];
}

export interface SessionPreferences {
  /** Conversation-owned provider. Secrets remain in SecretStorage. */
  provider: Provider;
  /** Conversation-owned model selection. */
  model: string;
  profileId?: string;
  effortOverride?: ReasoningEffort;
}

export interface SessionForkSource {
  sessionId: string;
  /** Number of chat history entries retained in the fork. Omitted for full clone. */
  historyLength?: number;
}

export interface SessionRecoveryMarker {
  phase: "running" | "waiting_user";
  startedAt: number;
  updatedAt: number;
  pendingQuestion?: string;
}

/**
 * Lightweight metadata used by the session browser. Do not put full messages here.
 * Keeping this record compact is what makes thousands of sessions cheap to browse.
 */
export interface SessionSummary {
  id: string;
  revision: number;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  preview: string;
  preferences: SessionPreferences;
  isPinned: boolean;
  isArchived: boolean;
  hasUnreadActivity: boolean;
  lastOutcome?: SessionRunOutcome;
  lastError?: string;
  forkedFrom?: SessionForkSource;
}

export interface PersistedSession extends SessionSummary {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  chatHistory: ChatHistoryEntry[];
  agentMessages: UnifiedMessage[];
  draft: SessionDraft;
  /**
   * Written only at lifecycle boundaries. If present after restart, the prior run
   * did not finish cleanly and must be surfaced as interrupted, never resumed blindly.
   */
  recovery?: SessionRecoveryMarker;
}

export interface SessionCatalog {
  schemaVersion: typeof SESSION_CATALOG_VERSION;
  generation: number;
  sessions: SessionSummary[];
}

export interface SessionManifest {
  schemaVersion: typeof SESSION_MANIFEST_VERSION;
  generation: number;
  /** Total non-archived sessions. Available without hydrating catalog shards. */
  activeCount: number;
  /** Total archived sessions. Available without hydrating archive metadata. */
  archivedCount: number;
  /** Total pinned, non-archived sessions. */
  pinnedCount: number;
  shardCount: typeof SESSION_CATALOG_SHARDS;
  hotRecentLimit: typeof SESSION_HOT_RECENT_LIMIT;
  /** A removal from the hot window may leave it underfilled until a maintenance refill. */
  hotNeedsRefill?: boolean;
  legacyImportedAt?: number;
  lastRebuildAt?: number;
}

export interface SessionStoreStats {
  activeCount: number;
  archivedCount: number;
  pinnedCount: number;
}

export interface SessionRunRequest {
  text: string;
  contextRefs?: ContextRef[];
  selection?: SelectionScope | null;
}

export interface SessionRuntimeSnapshot {
  session: PersistedSession;
  phase: SessionRunPhase;
  pendingQuestion: string | null;
  queuedAt: number | null;
}

export type SessionRuntimeEvent =
  | { type: "snapshot"; snapshot: SessionRuntimeSnapshot }
  | { type: "thinking" }
  | { type: "tool-call"; name: string; input: Record<string, unknown> }
  | { type: "tool-result"; name: string; result: ToolResult }
  | { type: "assistant"; text: string }
  | { type: "ask-user"; question: string }
  | { type: "run-state"; phase: SessionRunPhase }
  | { type: "run-complete"; outcome: SessionRunOutcome }
  | { type: "error"; message: string };

export interface SessionQuery {
  scope: "active" | "pinned" | "archived";
  search?: string;
  sort?: "activity" | "created";
  offset?: number;
  limit?: number;
}

export interface SessionQueryResult {
  items: SessionSummary[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export interface LegacyChatState {
  chatHistory?: Array<Partial<ChatHistoryEntry> & { type: ChatHistoryEntry["type"] }>;
  agentMessages?: UnifiedMessage[];
}

export function createSessionId(now = Date.now()): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 16);
  return `s_${now.toString(36)}_${random}`;
}

export function createHistoryId(now = Date.now()): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `m_${now.toString(36)}_${random}`;
}

export function deriveSessionTitle(history: readonly ChatHistoryEntry[]): string {
  const first = history.find((entry) => entry.type === "user" && entry.text?.trim());
  const source = first?.text?.replace(/\s+/g, " ").trim() ?? "";
  if (!source) return "New chat";
  return source.length <= 64 ? source : `${source.slice(0, 61).trimEnd()}...`;
}

export function deriveSessionPreview(history: readonly ChatHistoryEntry[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if ((entry.type === "user" || entry.type === "assistant") && entry.text?.trim()) {
      const source = entry.text.replace(/\s+/g, " ").trim();
      return source.length <= 120 ? source : `${source.slice(0, 117).trimEnd()}...`;
    }
  }
  return "";
}

export function summaryOf(session: PersistedSession): SessionSummary {
  const {
    schemaVersion: _schemaVersion,
    chatHistory: _chatHistory,
    agentMessages: _agentMessages,
    draft: _draft,
    recovery: _recovery,
    ...summary
  } = session;
  return {
    ...summary,
    lastError: summary.lastError
      ? (summary.lastError.length <= 240 ? summary.lastError : `${summary.lastError.slice(0, 237)}...`)
      : undefined,
  };
}

export function assertJsonSafe(value: unknown): void {
  const seen = new Set<object>();
  visitJson(value, "$", seen);
}

function visitJson(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || value === undefined) return;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return;
  if (kind === "bigint" || kind === "symbol" || kind === "function") {
    throw new Error(`Session state contains a non-JSON value at ${path}`);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error(`Session state contains binary data at ${path}`);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    throw new Error(`Session state contains Blob data at ${path}`);
  }
  if (typeof value !== "object") return;
  const object = value as object;
  if (seen.has(object)) throw new Error(`Session state contains a cycle at ${path}`);
  seen.add(object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitJson(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visitJson(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(object);
}
