import type { UnifiedMessage } from "../types";
import type { TurnExecutionConfig } from "./types";

/**
 * Stamp the most recent canonical user message with the execution config that
 * actually produced this turn's response. Tool-result "user" messages (arrays
 * of tool_result blocks, pushed mid-loop) are skipped deliberately — only the
 * true canonical user turn-starter (string content) gets provenance.
 */
export function stampLatestCanonicalUserMessage(
  messages: UnifiedMessage[],
  execution: TurnExecutionConfig,
): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    message.execution = {
      schemaVersion: 1,
      provider: execution.provider,
      model: execution.model,
      ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
    };
    return true;
  }
  return false;
}

export function readTurnExecutionProvenance(
  message: UnifiedMessage,
): UnifiedMessage["execution"] {
  const raw = message.execution;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.model !== "string") return undefined;
  if (raw.provider !== "anthropic" && raw.provider !== "openai" && raw.provider !== "chatgpt-oauth") {
    return undefined;
  }
  return raw;
}
