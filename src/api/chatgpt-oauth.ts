/**
 * ChatGPT OAuth API client (Experimental).
 *
 * Talks to the ChatGPT/Codex Responses-style endpoint using a bearer token
 * obtained via the Device Authorization Flow (see ../auth/chatgptOAuth.ts).
 *
 * Transport: always `stream: true`. The Codex backend rejects `stream:false`
 * outright with 400 `"Stream must be set to true"`, and the official Codex
 * CLI / other working OAuth-Codex clients never send anything else either.
 * Obsidian's `requestUrl()` buffers the entire SSE response before returning,
 * so we read the final body as text and parse it client-side — no streaming
 * IO required, which keeps mobile compatibility.
 *
 * Conversation continuity is **client-side**: we always send `store: false`
 * (the Codex backend rejects requests without it) and replay the full
 * conversation history into `input` every turn. We deliberately do NOT use
 * `previous_response_id` — it requires the server to persist the previous
 * response, which is incompatible with `store: false`.
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

/**
 * `originator` header value.
 *
 * The Codex backend uses this header to identify which client is calling
 * `/codex/responses`. In practice the value `"opencode"` (the official
 * OpenAI Codex CLI's identifier) is what the backend allows; custom values
 * are rejected with the same generic-looking 400s as malformed bodies.
 *
 * We send `"opencode"` to mirror what the official Codex CLI and other
 * working OAuth-Codex clients send. The user is already authenticated with
 * their own ChatGPT account, so this is purely a client-identity header,
 * not an auth claim.
 */
const ORIGINATOR = "opencode";

/**
 * `User-Agent` we attach to Codex requests.
 *
 * The OpenAI JS SDK that the official Codex CLI uses sends `OpenAI/JS X.Y.Z`.
 * Obsidian's `requestUrl()` doesn't add an OpenAI-flavored UA on its own,
 * so we set one explicitly. This is defensive — the backend may or may not
 * gate on UA, but matching the SDK's shape avoids surprises.
 */
const USER_AGENT = "OpenAI/JS 4.x obsidian-chatting/0.1";

// We deliberately do NOT discover Codex models at runtime. The Codex
// `/codex/models` endpoint either returns the same handful of slugs we
// already hardcode in settings.ts FALLBACK_MODELS["chatgpt-oauth"], or
// returns the chat.com UI catalog (dash-form slugs like `gpt-5-5` that
// `/codex/responses` rejects with HTTP 400). Either way, live discovery
// adds no value over the hardcoded list, which is mirrored from the
// official OpenAI Codex CLI's bundled `models.json`. Users can still pick
// "Custom..." in the settings dropdown to type any slug.

/** Held by main.ts; injected via setChatGPTOAuthService(). */
let oauthService: ChatGPTOAuthService | null = null;

export function setChatGPTOAuthService(service: ChatGPTOAuthService | null): void {
  oauthService = service;
}

/**
 * Reset any per-conversation client state (called from AgentLoop.clear()).
 *
 * The Codex backend forces us into stateless mode, so we don't actually
 * keep any cross-turn server identifiers. This function exists so the
 * agent loop can call it uniformly alongside the OpenAI provider's reset
 * — and so we have one place to add new state if we ever introduce it.
 */
export function clearChatGPTOAuthState(): void {
  /* no-op: history lives entirely in AgentLoop.messages */
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

  const baseBody: Record<string, unknown> = {
    model,
    // Replay the full conversation each turn — Codex's `store:false` mode
    // makes server-side `previous_response_id` chaining unavailable.
    input: buildFullHistoryInput(messages),
    instructions: systemPrompt,
    // Required by the Codex backend; omitting it returns
    // 400 {"detail":"Store must be set to false"}.
    store: false,
    // Match the request shape used by other working Codex-via-OAuth clients
    // (verified against the OpenAI Codex CLI and external references). These
    // fields aren't strictly documented as required, but Codex's response
    // pipeline expects them and at least one is required for reasoning models.
    parallel_tool_calls: true,
  };

  if (/^o\d/.test(model) || /^gpt-5/.test(model) || /codex/i.test(model)) {
    baseBody.reasoning = { effort: "medium", summary: "auto" };
    // Codex requires the encrypted reasoning payload to be threaded through
    // the request when reasoning is enabled. Without this, the backend
    // sometimes returns 400 on follow-up turns.
    baseBody.include = ["reasoning.encrypted_content"];
  }

  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    // Codex backend (and the OpenAI Responses API generally) accepts
    // `strict` on function tools. Setting `false` matches what the
    // official Codex CLI / other working OAuth-Codex clients send and
    // avoids unintended structured-output validation on free-form tools.
    strict: false,
  }));
  // Note: we deliberately do NOT push `web_search_preview` here, even when
  // `settings.enableWebSearch` is true. The Codex backend rejects every
  // hosted tool with HTTP 400 `"Unsupported tool type: <name>"` — it's a
  // coding-agent surface, not a general assistant surface, so only
  // function tools are supported. The Web search toggle still applies to
  // the Anthropic and OpenAI API-key providers as before.
  if (apiTools.length > 0) {
    baseBody.tools = apiTools;
  }

  // Codex backend only accepts streaming requests. We always send
  // `stream: true` and parse the buffered SSE body client-side.
  return sendOnce(
    { ...baseBody, stream: true },
    credential.accessToken,
    credential.accountId,
  );
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
    "User-Agent": USER_AGENT,
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
    // Codex returns errors as either `{detail: "..."}` (FastAPI-style) or
    // `{error: {message: "..."}}` (OpenAI-style). Extract whichever is present;
    // fall back to the raw body so the cause is never lost in translation.
    const json = response.json as
      | { error?: { message?: string }; detail?: string | { message?: string } }
      | undefined;
    const detailText =
      typeof json?.detail === "string"
        ? json.detail
        : json?.detail?.message;
    const apiMsg =
      detailText ??
      json?.error?.message ??
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

// ─── Input building ─────────────────────────────────────────────────────────

/**
 * Convert the agent loop's full message history into Responses-API input
 * items. The Codex backend rejects `previous_response_id` (because we must
 * send `store:false`), so every request carries the entire conversation.
 *
 * Encoding rules:
 *   - string content        → { type:"message", role, content }
 *   - text block            → { type:"message", role, content:text }
 *   - tool_use block        → { type:"function_call", call_id, name, arguments }
 *   - tool_result block     → { type:"function_call_output", call_id, output }
 *
 * The system prompt is sent separately via the `instructions` field, so we
 * never include it here.
 */
function buildFullHistoryInput(
  messages: UnifiedMessage[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      items.push({ type: "message", role, content: msg.content });
      continue;
    }

    for (const block of msg.content) {
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
