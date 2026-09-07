/**
 * Canonical persisted session metadata contract.
 *
 * This intentionally mirrors Claudian's current SessionMetadata contract rather
 * than introducing a Chatting-specific session metadata schema.
 *
 * Upstream reference (reviewed 2026-09-07):
 * YishenTu/claudian src/core/types/chat.ts @ main commit
 * 6a8e6c865251adc39f41806803e04cb1a1c3a7ed (see CLAUDIAN_STORAGE_CONTRACT.md /
 * THIRD_PARTY_NOTICES.md at the repo root of the Session Workspaces v4 kit).
 *
 * Chatting-specific state belongs inside providerState, not as new top-level
 * metadata fields. See docs/session-workspaces-v4/ for the full contract this
 * was integrated from.
 */

export type SessionProviderId = string;

export interface ConversationModelRecoverySource {
  sessionId: string | null;
  providerState?: Record<string, unknown>;
  resumeAtMessageId?: string;
}

export interface UsageInfo {
  model?: string;
  inputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow: number;
  contextWindowIsAuthoritative?: boolean;
  contextTokens: number;
  percentage: number;
}

/**
 * Keep this field set aligned with Claudian SessionMetadata.
 * Do not add Chatting-only top-level fields.
 */
export interface SessionMetadata {
  id: string;
  providerId?: SessionProviderId;
  title: string;
  titleGenerationStatus?: "pending" | "success" | "failed";
  createdAt: number;
  lastActivityAt: number;
  sessionId?: string | null;
  selectedModel?: string;
  providerState?: Record<string, unknown>;
  modelRecoverySource?: ConversationModelRecoverySource;
  linkedContentPath?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  externalContextPaths?: string[];
  usage?: UsageInfo;
  resumeAtMessageId?: string;
}

/**
 * Claudian's current lightweight conversation metadata shape. This is suitable
 * for derived navigation/search indexes. It is not the canonical session body.
 */
export interface ConversationMeta {
  id: string;
  providerId: SessionProviderId;
  selectedModel?: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  preview: string;
  linkedContentPath?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  titleGenerationStatus?: "pending" | "success" | "failed";
  isLegacySession?: boolean;
}

/**
 * Mirrors Claudian ConversationDeletionMarker.
 */
export const CONVERSATION_DELETION_MARKER_SCHEMA_VERSION = 1 as const;

export interface ConversationDeletionMarker {
  schemaVersion: typeof CONVERSATION_DELETION_MARKER_SCHEMA_VERSION;
  conversationId: string;
  deletedAt: number;
}

/** Reserved Claudian-facing provider id for this plugin's native history. */
export const CHATTING_PROVIDER_ID = "chatting" as const;

/**
 * Chatting-owned information stored in Claudian's opaque providerState bag.
 * The top-level SessionMetadata schema remains unchanged.
 */
export interface ChattingProviderState {
  history?: {
    format: "unified-message-jsonl";
    schemaVersion: 1;
    /** Vault-relative path to the provider-native Chatting transcript. */
    path: string;
    /** Monotone local history revision for crash/conflict detection. */
    revision?: number;
  };
  upstreamProvider?: string;
  profileId?: string | null;
  reasoningEffort?: string;
  webSearch?: boolean;
}

export function getChattingProviderState(
  metadata: SessionMetadata,
): ChattingProviderState {
  const state = metadata.providerState;
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  return state as ChattingProviderState;
}
