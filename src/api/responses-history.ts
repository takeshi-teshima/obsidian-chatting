import type { UnifiedMessage } from "../types";
import type { ImageResolver } from "../context/image-resolver";
import { buildResponsesVisionContent } from "./vision";

/**
 * Serialize the provider-neutral conversation into Responses API input items.
 *
 * Used when there is no safe server continuation id (OpenAI after restore /
 * session switch) and by ChatGPT OAuth/Codex, which always runs store:false.
 */
export async function buildResponsesHistoryInput(
  messages: readonly UnifiedMessage[],
  imageResolver?: ImageResolver,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";

    if (typeof message.content === "string") {
      if (message.role === "user") {
        const vision = await buildResponsesVisionContent(message, imageResolver);
        items.push({
          type: "message",
          role: "user",
          content: vision ?? message.content,
        });
      } else {
        items.push({
          type: "message",
          role: "assistant",
          content: message.content,
        });
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        items.push({ type: "message", role, content: block.text });
      } else if (block.type === "tool_use" && block.name && block.id) {
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content ?? "",
        });
      }
    }
  }

  return items;
}
