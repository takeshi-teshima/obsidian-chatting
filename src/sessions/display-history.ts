import type { ToolResult, UnifiedMessage } from "../types";

/**
 * UI-display-only reconstruction of the old `ChatHistoryEntry[]` shape from
 * canonical `UnifiedMessage[]` history. Per MIGRATION_HANDOFF.md §3 and
 * CLAUDIAN_STORAGE_CONTRACT.md, chatHistory-style display state is NOT part
 * of v4 canonical storage (there is no top-level chatHistory field in
 * SessionMetadata) — it is re-derived from the UnifiedMessage transcript on
 * load/reload/restart instead of being persisted as a second parallel store.
 *
 * This is a best-effort reconstruction for display/recovery purposes only,
 * never fed back into provider/model history:
 * - A leading `[Context: ...]` block the agent loop injects ahead of the
 *   user's literal text is stripped so the redisplayed bubble matches what
 *   the user actually typed as closely as possible.
 * - tool_use / tool_result content-block pairs are re-paired into the same
 *   toolName/toolInput/toolResult shape the chat view already renders.
 */
export interface DisplayEntry {
  type: "user" | "assistant" | "tool-result" | "error";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
}

const CONTEXT_PREFIX_RE = /^\[Context:[^\]]*\]\n\n/;
const SELECTION_PREFIX_RE = /^\[Selection scope:[\s\S]*?\n\nSelected text:\n>[^\n]*\n\n/;

export function deriveDisplayHistory(messages: readonly UnifiedMessage[]): DisplayEntry[] {
  const entries: DisplayEntry[] = [];
  const pendingToolUse = new Map<string, { name: string; input: Record<string, unknown> }>();

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.role === "user") {
        const text = stripInjectedPrefixes(message.content);
        if (text.trim()) entries.push({ type: "user", text });
      } else {
        if (message.content.trim()) entries.push({ type: "assistant", text: message.content });
      }
      continue;
    }

    // Content-block message: either an assistant turn (text/tool_use) or a
    // synthetic user-role message carrying only tool_result blocks.
    const isToolResultCarrier = message.role === "user" && message.content.every((b) => b.type === "tool_result");
    if (isToolResultCarrier) {
      for (const block of message.content) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const call = pendingToolUse.get(block.tool_use_id);
        if (!call) continue;
        entries.push({
          type: "tool-result",
          toolName: call.name,
          toolInput: call.input,
          toolResult: { result: block.content ?? "", isError: !!block.is_error },
        });
        pendingToolUse.delete(block.tool_use_id);
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text?.trim()) {
        entries.push({ type: message.role === "user" ? "user" : "assistant", text: block.text });
      } else if (block.type === "tool_use" && block.id && block.name) {
        pendingToolUse.set(block.id, { name: block.name, input: block.input ?? {} });
      }
    }
  }

  return entries;
}

function stripInjectedPrefixes(text: string): string {
  return text.replace(CONTEXT_PREFIX_RE, "").replace(SELECTION_PREFIX_RE, "");
}
