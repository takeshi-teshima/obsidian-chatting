import type { UnifiedMessage, ToolResult } from "../types";
import type { ContextRef } from "../context/refs";
import { isContextRef } from "../context/refs";
import type { ReasoningEffort } from "../model/reasoning";

export const SESSION_SCHEMA_VERSION = 1 as const;
export const SESSION_INDEX_SCHEMA_VERSION = 1 as const;

export interface ChatHistoryEntry {
  type: "user" | "assistant" | "tool-result" | "error";
  text?: string;
  contextRefs?: ContextRef[];
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
}

export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  profileId?: string;
  effortOverride?: ReasoningEffort;
}

export interface PersistedSession extends SessionMetadata {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  chatHistory: ChatHistoryEntry[];
  agentMessages: UnifiedMessage[];
}

export interface SessionIndex {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  activeSessionId: string | null;
  sessions: SessionMetadata[];
}

export interface LegacyChatState {
  chatHistory?: ChatHistoryEntry[];
  agentMessages?: UnifiedMessage[];
}

export const VALID_SESSION_EFFORTS = new Set<ReasoningEffort>([
  "auto",
  "low",
  "medium",
  "high",
  "max",
]);

export function isPersistedSession(value: unknown): value is PersistedSession {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== SESSION_SCHEMA_VERSION) return false;
  if (!isSessionMetadata(value)) return false;
  if (!Array.isArray(value.chatHistory) || !value.chatHistory.every(isChatHistoryEntry)) return false;
  if (!Array.isArray(value.agentMessages) || !value.agentMessages.every(isUnifiedMessage)) return false;
  return true;
}

export function isSessionIndex(value: unknown): value is SessionIndex {
  if (!isRecord(value) || value.schemaVersion !== SESSION_INDEX_SCHEMA_VERSION) return false;
  if (value.activeSessionId !== null && typeof value.activeSessionId !== "string") return false;
  return Array.isArray(value.sessions) && value.sessions.every(isSessionMetadata);
}

export function isLegacyChatState(value: unknown): value is LegacyChatState {
  if (!isRecord(value)) return false;
  if (value.chatHistory !== undefined && (!Array.isArray(value.chatHistory) || !value.chatHistory.every(isChatHistoryEntry))) return false;
  if (value.agentMessages !== undefined && (!Array.isArray(value.agentMessages) || !value.agentMessages.every(isUnifiedMessage))) return false;
  return value.chatHistory !== undefined || value.agentMessages !== undefined;
}

export function deriveSessionTitle(history: readonly ChatHistoryEntry[]): string {
  const firstUser = history.find((entry) => entry.type === "user" && typeof entry.text === "string" && entry.text.trim());
  if (!firstUser?.text) return "New chat";
  const oneLine = firstUser.text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 56) return oneLine;
  return `${oneLine.slice(0, 53).trimEnd()}...`;
}

export function createSessionId(now = Date.now()): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14).padEnd(12, "0");
  return `s_${now.toString(36)}_${random}`;
}

/** Reject browser binary objects/cycles before JSON.stringify silently erases them. */
export function assertJsonSafe(value: unknown): void {
  const seen = new Set<object>();
  visit(value, "$", seen);
}

function visit(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return;
  if (type === "bigint" || type === "symbol" || type === "function") {
    throw new Error(`Session state contains non-JSON value at ${path}`);
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
    value.forEach((item, index) => visit(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visit(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(object);
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !/^s_[a-z0-9_]+$/i.test(value.id)) return false;
  if (typeof value.title !== "string") return false;
  if (!finiteTimestamp(value.createdAt) || !finiteTimestamp(value.updatedAt)) return false;
  if (value.profileId !== undefined && typeof value.profileId !== "string") return false;
  if (value.effortOverride !== undefined && !VALID_SESSION_EFFORTS.has(value.effortOverride as ReasoningEffort)) return false;
  return true;
}

function isChatHistoryEntry(value: unknown): value is ChatHistoryEntry {
  if (!isRecord(value)) return false;
  if (value.type !== "user" && value.type !== "assistant" && value.type !== "tool-result" && value.type !== "error") return false;
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (value.contextRefs !== undefined && (!Array.isArray(value.contextRefs) || !value.contextRefs.every(isContextRef))) return false;
  if (value.toolName !== undefined && typeof value.toolName !== "string") return false;
  if (value.toolInput !== undefined && !isRecord(value.toolInput)) return false;
  if (value.toolResult !== undefined && !isToolResult(value.toolResult)) return false;
  return true;
}

function isUnifiedMessage(value: unknown): value is UnifiedMessage {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return false;
  if (typeof value.content !== "string") {
    if (!Array.isArray(value.content) || !value.content.every(isContentBlock)) return false;
  }
  if (value.contextRefs !== undefined && (!Array.isArray(value.contextRefs) || !value.contextRefs.every(isContextRef))) return false;
  return true;
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === "text" || value.type === "tool_use" || value.type === "tool_result";
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value) && typeof value.result === "string" && typeof value.isError === "boolean";
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
