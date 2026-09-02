import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";
import { resolveReasoningConfig } from "../model/reasoning";
import type { ProviderRequestContext } from "./vision";
import { buildResponsesVisionContent } from "./vision";
import { buildResponsesHistoryInput } from "./responses-history";

const DEFAULT_OPENAI_URL = "https://api.openai.com";

/**
 * Sends a message to OpenAI via the Responses API (/v1/responses).
 * Uses the `previous_response_id` field for multi-turn, which lets
 * OpenAI manage conversation state server-side and avoids us having to
 * reconstruct function_call items.
 *
 * Conversation continuity (`previous_response_id`) is carried in
 * `requestContext.providerState` — a per-SessionRuntime object, never a
 * module-level global. This is required for correctness once multiple
 * sessions can run concurrently: a module global would let session B's
 * continuation id leak into session A's request (or vice versa).
 */
export async function sendOpenAIMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  requestContext?: ProviderRequestContext
): Promise<UnifiedResponse> {
  const baseUrl = DEFAULT_OPENAI_URL;
  const model = settings.model || "gpt-5.3-codex";

  const openaiState = requestContext?.providerState?.openai;
  const usePreviousResponse = !!openaiState
    && !openaiState.requiresHistoryReplay
    && !!openaiState.previousResponseId;

  // Build input. When there is no trusted server-side continuation id
  // (first request after hydration/restart, or no providerState at all —
  // e.g. a one-off settings connection test), replay the full history and
  // omit previous_response_id. Otherwise send only this turn's new items.
  const input = usePreviousResponse
    ? await buildCurrentTurnInput(messages, requestContext?.images)
    : [
        { type: "message", role: "developer", content: systemPrompt },
        ...(await buildResponsesHistoryInput(messages, requestContext?.images)),
      ];

  const body: Record<string, unknown> = {
    model,
    input,
  };

  // Chain to previous response for multi-turn context
  if (usePreviousResponse) {
    body.previous_response_id = openaiState!.previousResponseId;
  }

  // Reasoning for reasoning-capable models
  const reasoning = resolveReasoningConfig("openai", model, settings.reasoningEffort);
  if (reasoning.enabled) {
    body.reasoning = reasoning.effort ? { effort: reasoning.effort } : {};
  }

  // Tools
  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

  if (settings.enableWebSearch) {
    apiTools.push({ type: "web_search_preview" });
  }

  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    const apiMsg = getNestedString(err, ["json", "error", "message"]);
    if (apiMsg) {
      throw new Error(`OpenAI API error (${status || "unknown"}): ${apiMsg}`);
    }
    throw new Error(`OpenAI request failed (${status}): ${message}`);
  }

  if (response.status !== 200) {
    const errorBody = getNestedString(response.json as unknown, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const data = asRecord(response.json as unknown);

  // Store response ID for chaining, scoped to this runtime's provider state only.
  if (openaiState) {
    openaiState.previousResponseId = typeof data.id === "string" ? data.id : null;
    openaiState.requiresHistoryReplay = false;
  }

  return fromResponsesOutput(data);
}

// ─── Input Building ─────────────────────────────────────────────────────────

/**
 * Builds input items for the current turn only. Only called when a trusted
 * `previous_response_id` is available (i.e. we are NOT replaying full
 * history), so we only need to send:
 * - On tool result calls: function_call_output items
 * - On follow-up user messages: user message
 */
async function buildCurrentTurnInput(
  messages: UnifiedMessage[],
  resolver?: ProviderRequestContext["images"]
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];

  // Only send the latest turn's items
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return items;

  if (typeof lastMsg.content === "string") {
    const visionContent = await buildResponsesVisionContent(lastMsg, resolver);
    items.push({
      type: "message",
      role: "user",
      content: visionContent ?? lastMsg.content,
    });
    return items;
  }

  // Tool results
  const toolResults = lastMsg.content.filter((b) => b.type === "tool_result");
  if (toolResults.length > 0) {
    for (const tr of toolResults) {
      items.push({
        type: "function_call_output",
        call_id: tr.tool_use_id,
        output: tr.content || "",
      });
    }
    return items;
  }

  // Text content
  const text = lastMsg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (text) {
    items.push({
      type: "message",
      role: lastMsg.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  return items;
}

// ─── Response Parsing ───────────────────────────────────────────────────────

function fromResponsesOutput(data: Record<string, unknown>): UnifiedResponse {
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
        input = isRecord(parsed) ? parsed : { _raw: parsed };
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: stringValue(item.call_id) || stringValue(item.id),
        name: stringValue(item.name),
        input,
      });
    }
  }

  const stopReason = hasToolCalls ? "tool_use" : "end_turn";
  const usage = isRecord(data.usage) ? data.usage : undefined;

  return {
    content,
    stopReason,
    usage: usage
      ? { inputTokens: numberValue(usage.input_tokens), outputTokens: numberValue(usage.output_tokens) }
      : undefined,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
