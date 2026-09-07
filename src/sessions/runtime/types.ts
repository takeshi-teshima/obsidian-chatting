import type { ContextRef } from "../../context/refs";
import type { SelectionScope, ToolResult, UnifiedMessage } from "../../types";
import type { ConversationMeta, SessionMetadata } from "../metadata/types";

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

export interface SessionDraft {
  text: string;
  contextRefs: ContextRef[];
}

export interface SessionRecoveryMarker {
  phase: "running" | "waiting_user";
  startedAt: number;
  updatedAt: number;
  pendingQuestion?: string;
  pendingInput?: {
    text: string;
    contextRefs?: ContextRef[];
  };
}

/**
 * Chatting-only, non-canonical UI/runtime state.
 * This is deliberately NOT SessionMetadata and is never projected into Claudian.
 */
export interface SessionLocalState {
  schemaVersion: 1;
  sessionId: string;
  draft: SessionDraft;
  hasUnreadActivity: boolean;
  lastOutcome?: SessionRunOutcome;
  lastError?: string;
  recovery?: SessionRecoveryMarker;
}

export interface LoadedSessionWorkspace {
  metadata: SessionMetadata;
  unknownMetadataFields: Record<string, unknown>;
  messages: UnifiedMessage[];
  localState: SessionLocalState;
}

export interface SessionRunRequest {
  text: string;
  contextRefs?: ContextRef[];
  selection?: SelectionScope | null;
}

export interface SessionRuntimeSnapshot {
  metadata: SessionMetadata;
  messages: UnifiedMessage[];
  localState: SessionLocalState;
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
  items: ConversationMeta[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

export interface SessionStoreStats {
  activeCount: number;
  archivedCount: number;
  pinnedCount: number;
}
