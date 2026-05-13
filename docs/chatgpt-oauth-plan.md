# ChatGPT OAuth — mobile-first plan

> Context: this repo is downstream of [Obsidian Chat](https://github.com/omarshahine/obsidian-chat). Upstream ships two providers (Anthropic, OpenAI) with API-key auth and an explicit non-streaming, mobile-first design. This document plans an additional **experimental** provider that lets the user authenticate with their ChatGPT account instead of supplying an OpenAI API key.

## Scope

**First version is intentionally narrow:**

- ✅ Add `chatgpt-oauth` as a third provider option, marked **Experimental**.
- ✅ Mobile-first login via **Device Authorization Flow** (no localhost callback).
- ✅ Token storage in Obsidian's `SecretStorage` (consistent with existing API-key handling).
- ✅ Token refresh.
- ✅ Reuse the existing OpenAI Responses input/output parser for chat + tool calls.
- ✅ Keep Anthropic and OpenAI API-key providers unchanged.
- ❌ No Gemini, no other providers.
- ❌ No browser-callback (`localhost:14xx`) flow as the primary login path.
- ❌ No streaming UI (upstream's non-streaming, `requestUrl()`-based architecture stays).
- ❌ No promise that every ChatGPT-side model will work.

## Why mobile must use Device Code Flow

A browser-callback OAuth flow needs a local HTTP server (e.g. `node:http` listening on `localhost`). That works on desktop Obsidian (Electron) but **not** on iOS/Android Obsidian, where Node modules are unavailable. Device Authorization Flow avoids the local server entirely:

1. The plugin POSTs to the device-authorization endpoint and gets a `user_code` plus a verification URL.
2. The user opens the URL in their phone browser, signs into ChatGPT, and enters the code.
3. The plugin polls the token endpoint (via Obsidian's `requestUrl()`) until it receives `access_token` / `refresh_token`.

Everything goes through `requestUrl()`, which works on every Obsidian platform.

## Risks (be honest with the user)

1. **Not the official OpenAI API.** ChatGPT-account auth talks to a ChatGPT/Codex backend, not `api.openai.com`. Endpoints, headers, and quotas are subject to change without notice. Mark this provider **Experimental** and keep "OpenAI API Key" as the recommended stable path.
2. **Streaming vs. `requestUrl()`.** Upstream Obsidian Chat is deliberately non-streaming because Obsidian's `requestUrl()` cannot expose a `ReadableStream` body — required for mobile compatibility. The Codex backend may default to streaming responses. Before committing to this provider we **must** spike whether the endpoint accepts non-streaming requests, or whether the full SSE response can be read as a single buffered string from `requestUrl()`.
3. **Token storage.** Tokens MUST go through `SecretStorage` — never `data.json`, never the conversation state, never logs.
4. **Backend volatility.** A ChatGPT-side change can break this provider overnight. Surface a clear error message and a "Reconnect / Switch to OpenAI API Key" CTA.

## Phase 0 — Spike (~½ to 1 day, blocks everything else)

Before writing provider code, verify the Codex Responses endpoint behaviour through `requestUrl()`:

1. Can we obtain a valid access token via Device Code Flow at all?
2. Does the endpoint return a complete JSON body when called with `stream: false` (or no `stream` field)?
3. If only streaming is supported, can `requestUrl()` return the full SSE text in a single response we can parse client-side?
4. Do `function_call` / tool-call responses come back in a usable shape?

**Decision matrix:**

| Spike result | Verdict |
|---|---|
| Non-streaming JSON works | Best — drop straight into upstream's existing architecture. |
| Streaming-only, but SSE buffered text is parseable | Workable — write a one-shot SSE text parser. |
| Neither works on mobile | Abort. Do not ship this provider. |

## Phase 1 — Provider type + settings UI

Extend the provider union:

```ts
export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt-oauth";
```

Settings page:

```
Provider
  ( ) Anthropic
  ( ) OpenAI
  ( ) ChatGPT OAuth  [Experimental]

If chatgpt-oauth selected:
  - Hide API Key input.
  - Show Connect / Disconnect / Status.
  - Show clear "Experimental" warning copy.
```

Suggested warning copy:

> ChatGPT OAuth is **experimental**. It uses your ChatGPT account session for ChatGPT/Codex backend access. Availability, quotas, models, and endpoints may change at any time. The OpenAI API Key provider remains the recommended stable option.

## Phase 2 — Device Code Flow (the only login path in v1)

Files:

```
src/auth/chatgptOAuth.ts
src/auth/chatgptOAuthStore.ts
src/auth/chatgptOAuthDeviceFlow.ts
```

Core types:

```ts
export interface ChatGPTOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;     // epoch ms
  updatedAt: number;     // epoch ms
  accountId?: string;
  idToken?: string;
}

export interface ChatGPTDeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
}
```

Functions:

```ts
async function beginChatGPTDeviceAuthorization(): Promise<ChatGPTDeviceAuthorization>;
async function pollChatGPTDeviceAuthorization(
  auth: ChatGPTDeviceAuthorization,
): Promise<ChatGPTOAuthCredential>;
async function refreshChatGPTCredential(
  credential: ChatGPTOAuthCredential,
): Promise<ChatGPTOAuthCredential>;
```

All HTTP calls go through Obsidian's `requestUrl()`. No `node:http`, no `fetch` streaming.

## Phase 3 — Mobile UI

Three states:

**Disconnected**

```
ChatGPT OAuth (Experimental)
Status: Not connected
[ Connect ChatGPT ]
```

**Awaiting authorization**

```
1. Open this page:
   <verification URL>
2. Enter this code:
   ABCD-EFGH
[ Copy Code ]   [ Open Login Page ]   [ Cancel ]

Waiting for authorization…
You can return here after signing in.
```

**Connected**

```
ChatGPT OAuth (Experimental)
Status: Connected
Account: <masked>
[ Disconnect ]
```

**Error states** must be explicit, never silent (see Phase 7).

## Phase 4 — Token storage

Use Obsidian `SecretStorage`. Never `data.json`, never conversation state, never logs.

```ts
// Obsidian's SecretStorage validates IDs as lowercase alphanumeric + dashes only.
// No colons, no uppercase. Keys must match that grammar.
const CHATGPT_OAUTH_SECRET_KEY = "chatting-with-ai-chatgpt-oauth";

// Save
app.secretStorage.setSecret(
  CHATGPT_OAUTH_SECRET_KEY,
  JSON.stringify(credential),
);

// Load
const raw = app.secretStorage.getSecret(CHATGPT_OAUTH_SECRET_KEY);
const credential = raw ? (JSON.parse(raw) as ChatGPTOAuthCredential) : null;

// Clear (no delete API — overwrite with empty string)
app.secretStorage.setSecret(CHATGPT_OAUTH_SECRET_KEY, "");
```

(API confirmed against `obsidian.d.ts` `SecretStorage` class — `setSecret`/`getSecret`/`listSecrets`, all sync, available since Obsidian 1.11.4.)

## Phase 5 — Provider implementation

New file: `src/api/chatgpt-oauth.ts`. Mirror the existing OpenAI Responses provider but swap:

| Field | Value |
|---|---|
| Endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| Authorization | `Bearer <accessToken>` |
| `originator` header | a stable identifier for this client |
| `ChatGPT-Account-Id` header | from credential, when present |
| Streaming | as decided in Phase 0 |

Reuse upstream's existing builders for Responses-API request bodies and the parser for `previous_response_id`, tool calls, `function_call_output`, web search, and reasoning. Do not duplicate that logic — extract it if needed.

## Phase 6 — Tool-call verification

Smoke-test the core agentic tools through this provider on real mobile devices. v1 must at minimum cover:

- `read_file`
- `search_vault`
- `edit_document`
- `create_file`

If function calls don't round-trip cleanly, the provider isn't shippable — the value of this plugin is agentic vault operations, not plain chat.

## Phase 7 — Error handling

| Situation | User-facing message |
|---|---|
| Not connected | "ChatGPT OAuth is not connected. Open Settings → Provider → Connect ChatGPT." |
| Token expired, refresh succeeds | (silent — user sees nothing) |
| Token expired, refresh fails | "ChatGPT OAuth session expired. Please reconnect your ChatGPT account." |
| Endpoint 4xx/5xx | "ChatGPT OAuth request failed. This experimental provider may not support the selected model or request format. Try reconnecting or switch to OpenAI API Key." |
| Device code expired before user finished | "Login expired. Please start ChatGPT login again." |

## Difficulty assessment

| Module | Difficulty | Notes |
|---|---:|---|
| Provider type extension | Low | Add one variant. |
| Device Code Flow | Medium | Standard OAuth 2.0 device flow over `requestUrl()`. |
| `SecretStorage` integration | Medium | Adapt to current settings layer. |
| Token refresh | Medium | Standard refresh-token exchange. |
| Codex endpoint compatibility | Medium-high | The streaming question is the dominant unknown — Phase 0 spike de-risks it. |
| Tool-call compatibility | Medium | Reusing upstream's Responses parser should make this mostly free. |
| Real-device mobile QA | Medium-high | Both iOS and Android. |

## Definition of done for v1

- Phase 0 spike has a documented "yes / no / which path" outcome.
- Settings UI shows the new provider with a clear Experimental badge and warning.
- Device Code Flow login completes on iOS, Android, and desktop.
- Tokens live only in `SecretStorage`.
- Refresh flow is exercised (manually expire, confirm seamless re-auth).
- The four core tool calls succeed on a real mobile device.
- Failure modes from Phase 7 are wired up and tested.
