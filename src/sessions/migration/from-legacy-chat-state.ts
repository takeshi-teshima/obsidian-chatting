import type { LegacyReadAdapter } from "./legacy-adapter";
import type { LegacySessionLike } from "./types";

export const LEGACY_CHAT_STATE_SESSION_ID = "legacy-chat-state";

/**
 * Reads the pre-multi-session single `chat-state.json`, using the exact
 * legacy path candidates the branch-10 checkout already recognizes
 * (`ChatPlugin.chatStatePath` / `legacyChatStatePath`), per
 * MIGRATION_HANDOFF.md §1.C ("use the actual checkout's candidates, don't
 * invent a single path").
 *
 * Caller is responsible for only invoking this when no valid branch-11/v3
 * session exists (MIGRATION_HANDOFF.md §12's bootstrap order: the single
 * legacy chat is only a source of truth when nothing more specific exists).
 */
export async function readLegacyChatState(
  adapter: LegacyReadAdapter,
  candidatePaths: readonly string[],
  currentProvider?: string,
  currentModel?: string,
): Promise<{ path: string; session: LegacySessionLike } | null> {
  for (const path of candidatePaths) {
    if (!await adapter.exists(path)) continue;
    try {
      const raw = await adapter.read(path);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      const chatHistory = Array.isArray(record.chatHistory) ? record.chatHistory : [];
      const agentMessages = Array.isArray(record.agentMessages) ? (record.agentMessages as never) : [];
      if (chatHistory.length === 0 && (agentMessages as unknown[]).length === 0) {
        // An empty legacy state is not useful to import as a phantom
        // conversation; keep scanning other candidates just in case.
        continue;
      }
      const stat = await adapter.stat(path);
      const timestamp = stat?.mtime ?? Date.now();
      return {
        path,
        session: {
          id: LEGACY_CHAT_STATE_SESSION_ID,
          title: deriveTitle(chatHistory),
          createdAt: timestamp,
          updatedAt: timestamp,
          // Only acceptable because this is the single legacy *active* chat,
          // per MIGRATION_HANDOFF.md §2: today's global settings may stand
          // in for the historical active-chat provider/model here (and only
          // here — never for inactive old sessions).
          provider: currentProvider,
          model: currentModel,
          chatHistory,
          agentMessages,
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

function deriveTitle(chatHistory: unknown[]): string {
  const first = chatHistory.find(
    (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "user",
  ) as Record<string, unknown> | undefined;
  const text = typeof first?.text === "string" ? first.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return "Imported chat";
  return text.length <= 64 ? text : `${text.slice(0, 61).trimEnd()}...`;
}
