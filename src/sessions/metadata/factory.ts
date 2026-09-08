import {
  CHATTING_PROVIDER_ID,
  type ChattingProviderState,
  type SessionMetadata,
} from "./types";

export interface CreateSessionMetadataInput {
  id: string;
  title?: string;
  now?: number;
  selectedModel?: string;
  upstreamProvider?: string;
  historyPath: string;
  profileId?: string | null;
  reasoningEffort?: string;
  webSearch?: boolean;
}

export function createSessionMetadata(
  input: CreateSessionMetadataInput,
): SessionMetadata {
  const now = input.now ?? Date.now();
  const chattingState: ChattingProviderState = {
    history: {
      format: "unified-message-jsonl",
      schemaVersion: 1,
      path: input.historyPath,
      revision: 0,
    },
    ...(input.upstreamProvider ? { upstreamProvider: input.upstreamProvider } : {}),
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.webSearch !== undefined ? { webSearch: input.webSearch } : {}),
  };

  return {
    id: input.id,
    providerId: CHATTING_PROVIDER_ID,
    title: input.title?.trim() || "New chat",
    createdAt: now,
    lastActivityAt: now,
    sessionId: input.id,
    ...(input.selectedModel ? { selectedModel: input.selectedModel } : {}),
    providerState: chattingState as Record<string, unknown>,
    isPinned: false,
    isArchived: false,
  };
}
