import type { ConversationMeta, SessionMetadata } from "../metadata/types";

/**
 * Rebuildable navigation index entry. We intentionally reuse Claudian's
 * ConversationMeta shape instead of inventing a SessionSummary schema.
 */
export type SessionIndexEntry = ConversationMeta;

export function toConversationMeta(
  metadata: SessionMetadata,
  details: { messageCount: number; preview: string },
): ConversationMeta {
  return {
    id: metadata.id,
    providerId: metadata.providerId ?? "chatting",
    ...(metadata.selectedModel ? { selectedModel: metadata.selectedModel } : {}),
    title: metadata.title,
    createdAt: metadata.createdAt,
    lastActivityAt: metadata.lastActivityAt,
    messageCount: details.messageCount,
    preview: details.preview,
    ...(metadata.linkedContentPath ? { linkedContentPath: metadata.linkedContentPath } : {}),
    ...(metadata.isPinned !== undefined ? { isPinned: metadata.isPinned } : {}),
    ...(metadata.isArchived !== undefined ? { isArchived: metadata.isArchived } : {}),
    ...(metadata.titleGenerationStatus ? { titleGenerationStatus: metadata.titleGenerationStatus } : {}),
  };
}

export function sortConversationMeta(
  entries: readonly ConversationMeta[],
  by: "activity" | "created" = "activity",
): ConversationMeta[] {
  return [...entries].sort((a, b) => {
    const left = by === "activity" ? a.lastActivityAt : a.createdAt;
    const right = by === "activity" ? b.lastActivityAt : b.createdAt;
    return right - left
      || a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true })
      || a.id.localeCompare(b.id);
  });
}
