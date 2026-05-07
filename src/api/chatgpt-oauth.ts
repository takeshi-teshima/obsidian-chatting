/**
 * ChatGPT OAuth API client (Experimental).
 *
 * Talks to the ChatGPT/Codex Responses-style endpoint using a bearer token
 * obtained via the Device Authorization Flow (see ../auth/chatgptOAuth.ts).
 *
 * Two transport paths, attempted in order:
 *   1. Buffered streaming: send `stream: true`, let Obsidian's `requestUrl()`
 *      buffer the entire SSE response, then parse it client-side. This is
 *      the most reliable path on the Codex backend — that endpoint is built
 *      to stream — and it works on mobile because we never read a streaming
 *      body, only the final buffered text.
 *   2. Non-streaming JSON: if the server rejects `stream: true` with a 4xx,
 *      retry with `stream: false`. Some deployments may prefer this.
 *
 * Conversation continuity uses `previous_response_id`, identical to the
 * upstream OpenAI provider. We store the last response id locally; on
 * `clearChatGPTOAuthState()` (called by AgentLoop.clear()) we drop it.
 */
import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "../types";
import {
  ChatGPTOAuthError,
  type ChatGPTOAuthService,
} from "../auth/chatgptOAuth";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR = "obsidian-chatting";

let previousResponseId: string | null = null;

/** Held by main.ts; injected via setChatGPTOAuthService(). */
let oauthService: ChatGPTOAuthService | null = null;

export function setChatGPTOAuthService(service: ChatGPTOAuthService | null): void {
  oauthService = service;
}

/** Clear the conversation chain (call when the user clears chat). */
export function clearChatGPTOAuthState(): void {
  previousResponseId = null;
}

export async function sendChatGPTOAuthMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
): Promise<UnifiedResponse> {
  if (!oauthService) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth service is not initialized. Reload the plugin.",
    );
  }

  let credential;
  try {
    credential = await oauthService.getUsableCredential();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth session expired and refresh failed. Please reconnect your ChatGPT account in settings. (${msg})`,
    );
  }
  if (!credential) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth is not connected. Open Settings → Obsidian Chatting → Connect ChatGPT.",
    );
  }

  const model = settings.model || CHATGPT_OAUTH_DEFAULT_MODEL;

  const input = buildCurrentTurnInput(messages, systemPrompt);

  const baseBody: Record<string, unknown> = {
    model,
    input,
    instructions: systemPrompt,
  };

  if (previousResponseId) {
    baseBody.previous_response_id = previousResponseId;
  }

  if (/^o\d/.test(model) || /^gpt-5/.test(model) || /codex/i.test(model)) {
    baseBody.reasoning = { effort: "medium" };
  }

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
    baseBody.tools = apiTools;
  }

  // Try streaming first (Codex's native mode), fall back to non-streaming
  // only if the server rejects the streaming request as malformed.
  try {
    return await sendOnce({ ...baseBody, stream: true }, credential.accessToken, credential.accountId);
  } catch (e) {
    if (isBadRequestError(e)) {
      return sendOnce({ ...baseBody, stream: false }, credential.accessToken, credential.accountId);
    }
    throw e;
  }
}

async function sendOnce(
  body: Record<string, unknown>,
  accessToken: string,
  accountId: string | undefined,
): Promise<UnifiedResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    originator: ORIGINATOR,
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  let response;
  try {
    response = await requestUrl({
      url: CODEX_RESPONSES_URL,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth request failed (${err.status ?? ""}): ${err.message ?? String(e)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth session rejected by the server (HTTP ${response.status}). Please reconnect your ChatGPT account in settings.`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    const apiMsg =
      (response.json as { error?: { message?: string } } | undefined)?.error?.message ??
      response.text?.slice(0, 300) ??
      `HTTP ${response.status}`;
    const err = new ChatGPTOAuthError(
      `ChatGPT OAuth request failed (${response.status}): ${apiMsg}. This experimental provider may not support the selected model or request format. Try reconnecting or switch to OpenAI API Key.`,
    );
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }

  // Two possible response shapes:
  //   - JSON object (non-streaming or `response.completed` already aggregated)
  //   - SSE text body (streaming, buffered by requestUrl)
  const data = parseResponseBody(response);
  previousResponseId = (data.id as string | undefined) ?? previousResponseId;
  return fromResponsesOutput(data);
}

function parseResponseBody(response: {
  text?: string;
  json?: unknown;
}): Record<string, unknown> {
  if (response.json && typeof response.json === "object") {
    const obj = response.json as Record<string, unknown>;
    // If the JSON parser already gave us the final response, use it.
    if (obj.output || obj.id) return obj;
  }

  const text = response.text ?? "";
  if (!text) {
    throw new ChatGPTOAuthError("ChatGPT OAuth response was empty.");
  }

  // SSE: lines beginning with `data: ` are JSON events. Find the
  // `response.completed` event (or `response.incomplete` as a fallback) and
  // return its `response` payload, which has the same shape as the
  // non-streaming Responses API result.
  const events = parseSSE(text);
  let lastResponse: Record<string, unknown> | null = null;
  let failureMessage: string | null = null;

  for (const evt of events) {
    const type = evt.type as string | undefined;
    if (type === "response.completed" && evt.response) {
      return evt.response as Record<string, unknown>;
    }
    if (type === "response.incomplete" && evt.response) {
      lastResponse = evt.response as Record<string, unknown>;
    }
    if (type === "response.failed") {
      const err = (evt.response as { error?: { message?: string } })?.error;
      failureMessage = err?.message ?? "ChatGPT OAuth response failed";
    }
    if (type === "error" && typeof evt.message === "string") {
      failureMessage = evt.message;
    }
  }

  if (lastResponse) return lastResponse;
  if (failureMessage) throw new ChatGPTOAuthError(failureMessage);

  // If we got JSON but it wasn't recognizable, fall through with what we have.
  if (response.json && typeof response.json === "object") {
    return response.json as Record<string, unknown>;
  }

  throw new ChatGPTOAuthError(
    "ChatGPT OAuth stream ended without a completed response.",
  );
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  // SSE events are separated by blank lines. Each event has `data:` lines
  // (potentially multi-line JSON) and optional `event:` / `id:` lines we
  // can ignore — the JSON payload always carries `type`.
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // ignore malformed event
    }
  }
  return events;
}

function isBadRequestError(e: unknown): boolean {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status?: number }).status;
    return status === 400 || status === 422;
  }
  return false;
}

// ─── Input building (mirrors openai.ts) ─────────────────────────────────────

function buildCurrentTurnInput(
  messages: UnifiedMessage[],
  systemPrompt: string,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  if (!previousResponseId) {
    items.push({
      type: "message",
      role: "developer",
      content: systemPrompt,
    });

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        items.push({
          type: "message",
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }
    return items;
  }

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg) return items;

  if (typeof lastMsg.content === "string") {
    items.push({
      type: "message",
      role: "user",
      content: lastMsg.content,
    });
    return items;
  }

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

  const text = lastMsg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (text) {
    items.push({
      type: "message",
      role: lastMsg.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  return items;
}

// ─── Response parsing (mirrors openai.ts) ───────────────────────────────────

function fromResponsesOutput(data: Record<string, unknown>): UnifiedResponse {
  const output = (data.output || []) as Array<Record<string, unknown>>;
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content as Array<Record<string, unknown>>) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse((item.arguments as string) || "{}");
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: (item.call_id || item.id) as string,
        name: item.name as string,
        input,
      });
    }
  }

  const stopReason = hasToolCalls ? "tool_use" : "end_turn";
  const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    content,
    stopReason,
    usage: usage
      ? { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 }
      : undefined,
  };
}
