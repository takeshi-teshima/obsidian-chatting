/**
 * Repairs tool_use/tool_result pairing in a message history.
 *
 * This is deliberately NOT the primary defense against a dangling call
 * during live execution — that's AgentLoop.run() in loop.ts, which now
 * commits an assistant's tool_use message and its tool_result message
 * together in one synchronous step (see the commit comment there), so a
 * live turn interrupted by anything (macOS sleep, lost network, a hung
 * `ask_user` await, a future bug) simply never gets partially written to
 * `this.messages` in the first place. Sanitizing after the fact everywhere
 * a provider request gets built would paper over that invariant instead of
 * enforcing it, and would quietly hide a *future* regression that breaks
 * the invariant again — so this is intentionally NOT called on every
 * request; only at the two points below, where an already-broken pairing
 * can legitimately still arrive from outside AgentLoop's own control:
 *
 *   1. AgentLoop.importMessages() (session hydration): a session saved by
 *      an older build of this plugin (before the atomic-commit fix), or
 *      one that reached disk mid-turn through some path outside
 *      AgentLoop's control (e.g. a hard process kill / power loss, where
 *      no in-app code runs to maintain any invariant), may already contain
 *      a dangling tool_use on disk. This is a one-time repair on load, not
 *      an ongoing tolerance policy.
 *   2. pruneHistory()'s positional truncation: `slice(-KEEP_RECENT)` has no
 *      pairing awareness, and can cut a *previously valid* {tool_use,
 *      tool_result} pair in half. This is a different mechanism from live
 *      interruption (it only ever produces an orphaned tool_result, since
 *      slicing removes from the front and a call always precedes its
 *      result) and isn't addressed by the atomic-commit fix at all, so
 *      this repair is still load-bearing there.
 *
 * What it does:
 *   - A tool_result block whose tool_use_id has no matching tool_use
 *     anywhere in the history is dropped — there is nothing meaningful to
 *     pair it with, and sending it as-is is exactly the shape the backend
 *     rejects ("No tool call found for function call output with call_id
 *     ...").
 *   - A tool_use block with no matching tool_result anywhere in the
 *     history gets a synthetic error tool_result appended right after it
 *     (this direction is only reachable via path 1 above, not pruning).
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
