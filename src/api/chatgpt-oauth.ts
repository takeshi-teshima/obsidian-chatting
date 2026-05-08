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
const ORIGINATOR = "obsidian-chatting";

/**
 * Canonical Codex model-catalog endpoint.
 *
 * This is the same `/models` endpoint the official OpenAI Codex CLI hits
 * (see openai/codex `codex-rs/model-provider/src/models_endpoint.rs`). It
 * returns slugs the Codex `/responses` endpoint actually accepts, in the
 * documented `ModelInfo` schema.
 *
 * We deliberately do NOT fall back to `chatgpt.com/backend-api/models` —
 * that is the chat.com UI catalog and uses dash-separated slugs like
 * `gpt-5-5` that the Codex backend rejects with HTTP 400
 * `"The 'gpt-5-5' model is not supported when using Codex with a ChatGPT account."`.
 */
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";

export interface ChatGPTOAuthModel {
  id: string;
  label: string;
}

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

/**
 * Best-effort fetch of available models for the ChatGPT OAuth provider.
 *
 * Probes the candidate URLs above using the current OAuth credential.
 * Returns a deduplicated, alphabetically-stable list on success. Throws a
 * descriptive ChatGPTOAuthError if every candidate fails — the caller is
 * expected to catch this and fall back to a hardcoded model list rather
 * than surface a hard failure.
 */
export async function fetchChatGPTOAuthModels(): Promise<ChatGPTOAuthModel[]> {
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
      `ChatGPT OAuth session expired and refresh failed. (${msg})`,
    );
  }
  if (!credential) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth is not connected. Connect ChatGPT first.",
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    originator: ORIGINATOR,
  };
  if (credential.accountId) {
    headers["ChatGPT-Account-Id"] = credential.accountId;
  }

  let response;
  try {
    response = await requestUrl({
      url: CODEX_MODELS_URL,
      method: "GET",
      headers,
      throw: false,
    });
  } catch (e) {
    throw new ChatGPTOAuthError(
      `Codex /models request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new ChatGPTOAuthError(
      `Codex /models returned HTTP ${response.status}. The ChatGPT/Codex ` +
        `backend may not expose a model-listing endpoint to your account ` +
        `tier, or the experimental provider is temporarily unavailable.`,
    );
  }

  const parsed = parseCodexModelsResponse(response.json);
  if (parsed.length === 0) {
    throw new ChatGPTOAuthError(
      "Codex /models returned an empty list.",
    );
  }
  return parsed;
}

/**
 * Parse the Codex backend's `/models` response into a UI-ready model list.
 *
 * Schema follows openai/codex `ModelInfo` (codex-rs/protocol/src/openai_models.rs):
 *
 *     { models: [
 *         { slug, display_name, priority, visibility: "list"|"hide"|"none", ... }
 *       ] }
 *
 * Filtering / sorting:
 *   - Drop entries whose `visibility` is `"hide"` or `"none"` (Codex CLI only
 *     surfaces `list`-visibility models in its picker).
 *   - Drop entries whose slug is empty.
 *   - Sort ascending by `priority` (lower = recommended first), ties broken
 *     by display name.
 */
function parseCodexModelsResponse(payload: unknown): ChatGPTOAuthModel[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw: Array<Record<string, unknown>> = Array.isArray(root.models)
    ? (root.models as Array<Record<string, unknown>>)
    : Array.isArray(payload as unknown)
      ? (payload as Array<Record<string, unknown>>)
      : [];

  const seen = new Set<string>();
  const accepted: Array<{ id: string; label: string; priority: number }> = [];

  for (const m of raw) {
    const slug = typeof m.slug === "string" ? m.slug : "";
    if (!slug || seen.has(slug)) continue;

    const visibility = typeof m.visibility === "string" ? m.visibility : "list";
    if (visibility !== "list") continue;

    const label =
      (typeof m.display_name === "string" && m.display_name) || slug;
    const priority =
      typeof m.priority === "number" && Number.isFinite(m.priority)
        ? m.priority
        : 999;

    seen.add(slug);
    accepted.push({ id: slug, label, priority });
  }

  accepted.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
  return accepted.map(({ id, label }) => ({ id, label }));
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
