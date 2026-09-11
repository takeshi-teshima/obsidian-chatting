/**
 * Repairs tool_use/tool_result pairing in a message history.
 *
 * Background: every provider adapter replays tool_use/tool_result content
 * blocks to the backend as call_id-paired items (`function_call` /
 * `function_call_output` in Responses-API terms — see api/chatgpt-oauth.ts
 * and api/openai.ts). If a turn is interrupted after the assistant's
 * tool_use message has been appended to history but before its matching
 * tool_result is appended (AgentLoop.run() in loop.ts pushes these as two
 * separate steps, with a tool execution `await` in between), the history
 * ends up with a dangling call and no result.
 *
 * This is NOT a rare edge case: closing the laptop lid / macOS App Nap
 * suspending background network activity mid-turn, losing wifi, force-
 * quitting Obsidian, or any bug in a future migration/import path can all
 * produce exactly this shape. When the resulting history is later replayed
 * (e.g. resuming the session and sending "Continue"), the ChatGPT OAuth /
 * Codex backend rejects it outright:
 *
 *   "No tool call found for function call output with call_id ..."
 *
 * (which can also occur in the mirror-image shape — an orphaned
 * function_call_output whose function_call never made it into history at
 * all, e.g. if a session file was hand-trimmed or partially migrated).
 *
 * Rather than trying to prevent every possible interruption at its source
 * (impossible — sleep/network loss is an ordinary environmental condition,
 * not a bug to "fix away"), this repairs the history unconditionally
 * before it's ever replayed, so a broken pairing can never reach a
 * provider as a malformed request:
 *
 *   - A tool_use block with no matching tool_result anywhere in the
 *     history gets a synthetic error tool_result appended right after it,
 *     explaining that the call was interrupted. This keeps the pairing
 *     valid AND lets the model see why its call didn't complete, instead
 *     of the call silently vanishing on the next turn.
 *   - A tool_result block whose tool_use_id has no matching tool_use
 *     anywhere in the history is dropped outright — there is nothing
 *     meaningful to pair it with, and sending it as-is is exactly the
 *     shape the backend rejects.
 *
 * Call this whenever a message history is loaded from persistence
 * (AgentLoop.importMessages) and, as a second line of defense, immediately
 * before building a provider request from live in-memory history — the
 * function is cheap (a couple of linear passes) and idempotent (running it
 * twice is a no-op), so there's no cost to calling it defensively in both
 * places.
 */
import type { ContentBlock, UnifiedMessage } from "../types";

const INTERRUPTED_TOOL_RESULT_TEXT =
  "Interrupted before this tool call finished (e.g. the app lost its connection or the computer went to sleep mid-turn). No result is available — treat this call as not having run, and retry it if it's still needed.";

export function sanitizeToolCallPairing(messages: UnifiedMessage[]): UnifiedMessage[] {
  const callIds = new Set<string>();
  const resolvedCallIds = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) callIds.add(block.id);
      if (block.type === "tool_result" && block.tool_use_id) resolvedCallIds.add(block.tool_use_id);
    }
  }

  if (callIds.size === 0 && resolvedCallIds.size === 0) {
    // Fast path: no tool calls anywhere in this history, nothing to repair.
    return messages;
  }

  const repaired: UnifiedMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      repaired.push(msg);
      continue;
    }

    const keptBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id && !callIds.has(block.tool_use_id)) {
        // Orphaned output: no call anywhere in the whole history to pair it
        // with. Drop it — this is precisely the shape the backend rejects.
        continue;
      }
      keptBlocks.push(block);
    }

    if (keptBlocks.length > 0) {
      const unchanged = keptBlocks.length === msg.content.length;
      repaired.push(unchanged ? msg : { ...msg, content: keptBlocks });
    }

    const danglingCalls = keptBlocks.filter(
      (b) => b.type === "tool_use" && !!b.id && !resolvedCallIds.has(b.id),
    );
    if (danglingCalls.length > 0) {
      repaired.push({
        role: "user",
        content: danglingCalls.map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.id!,
          content: INTERRUPTED_TOOL_RESULT_TEXT,
          is_error: true,
        })),
      });
    }
  }

  return repaired;
}
