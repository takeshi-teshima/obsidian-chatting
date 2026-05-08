/**
 * Smoke-test the ChatGPT/Codex Responses endpoint with the same request
 * shape the Obsidian plugin sends.
 *
 * Prerequisite: run `node test/codex-login.mjs` once to obtain a
 * credential at `temp/codex-token.json`.
 *
 * Usage:
 *
 *     node test/codex-smoke.mjs                       # default model + message
 *     node test/codex-smoke.mjs gpt-5.4               # specific model
 *     node test/codex-smoke.mjs gpt-5.5 "your text"   # specific message
 *     node test/codex-smoke.mjs --tools               # also exercise function-call
 *
 * Prints the HTTP status, response shape (JSON or SSE), all event types
 * observed, and the final assistant text or tool call. Refreshes the
 * stored token if it has expired.
 *
 * Mirrors the request body and headers in `src/api/chatgpt-oauth.ts`
 * exactly. If this script fails, the plugin will too — and vice versa.
 */
import { readFile, writeFile } from "node:fs/promises";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_PATH = "temp/codex-token.json";

// Must match src/api/chatgpt-oauth.ts:
const ORIGINATOR = "opencode";
const USER_AGENT = "OpenAI/JS 4.x obsidian-chatting/0.1";
const EXPIRY_BUFFER_MS = 30_000;

// ─── token management ──────────────────────────────────────────────────────

async function loadCredential() {
  let raw;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new Error(
      `No credential at ${TOKEN_PATH}. Run \`node test/codex-login.mjs\` first.`,
    );
  }
  return JSON.parse(raw);
}

async function refreshIfNeeded(credential) {
  if (credential.expiresAt > Date.now() + EXPIRY_BUFFER_MS) return credential;
  console.log("  refreshing access token...");
  const r = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`refresh HTTP ${r.status}: ${await r.text()}`);
  }
  const tokens = await r.json();
  const next = {
    ...credential,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    updatedAt: Date.now(),
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
  };
  await writeFile(TOKEN_PATH, JSON.stringify(next, null, 2));
  console.log(`  refreshed; new expiry: ${new Date(next.expiresAt).toLocaleString()}`);
  return next;
}

// ─── SSE parsing ──────────────────────────────────────────────────────────

function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
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
      /* malformed event */
    }
  }
  return events;
}

// ─── request building (mirrors src/api/chatgpt-oauth.ts) ──────────────────

function buildBody(model, userMessage, withTools, enableWebSearch) {
  const body = {
    model,
    input: [{ type: "message", role: "user", content: userMessage }],
    instructions: "You are a test harness. Respond briefly.",
    store: false,
    parallel_tool_calls: true,
    stream: true,
  };

  if (/^o\d/.test(model) || /^gpt-5/.test(model) || /codex/i.test(model)) {
    body.reasoning = { effort: "medium", summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  const tools = [];
  if (withTools) {
    tools.push({
      type: "function",
      name: "echo_back",
      description: "Echo the user's message back as-is. Use this if the user asks you to echo.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The text to echo." },
        },
        required: ["message"],
      },
      strict: false,
    });
  }
  if (enableWebSearch) {
    tools.push({ type: "web_search" });
  }
  if (tools.length > 0) body.tools = tools;

  return body;
}

// ─── main ─────────────────────────────────────────────────────────────────

function parseArgv() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  return {
    model: positional[0] || "gpt-5.5",
    message: positional[1] || "Say hello in one word.",
    withTools: flags.has("--tools"),
    enableWebSearch: flags.has("--web-search"),
  };
}

async function main() {
  const { model, message, withTools, enableWebSearch } = parseArgv();

  const credential = await refreshIfNeeded(await loadCredential());

  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: ORIGINATOR,
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const body = buildBody(model, message, withTools, enableWebSearch);

  console.log(`\n→ POST ${CODEX_RESPONSES_URL}`);
  console.log(`  model:     ${model}`);
  console.log(`  message:   ${JSON.stringify(message)}`);
  console.log(`  tools:     ${withTools ? "function tool" : "none"}${enableWebSearch ? " + web_search" : ""}`);
  console.log(`  body keys: ${Object.keys(body).join(", ")}\n`);

  const t0 = Date.now();
  const r = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const ms = Date.now() - t0;

  console.log(`← HTTP ${r.status}  (${ms}ms, ${text.length} bytes)`);
  console.log(`  content-type: ${r.headers.get("content-type") || "(none)"}\n`);

  if (!r.ok) {
    console.log("─── error body (first 2 KB) ───");
    console.log(text.slice(0, 2000));
    console.log("\n✗ FAIL");
    process.exit(1);
  }

  const events = parseSSE(text);
  console.log(`─── parsed ${events.length} SSE events ───`);
  const types = events.map((e) => e.type);
  const counts = types.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
  for (const [t, n] of Object.entries(counts)) console.log(`    ${t}: ${n}`);

  const completed = events.find((e) => e.type === "response.completed");
  if (!completed) {
    console.log("\n✗ FAIL — no response.completed event");
    console.log("  last 3 events:");
    for (const e of events.slice(-3)) {
      console.log("    " + JSON.stringify(e).slice(0, 300));
    }
    process.exit(1);
  }

  const output = completed.response?.output ?? [];
  console.log(`\n─── response.completed (${output.length} output items) ───`);
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text") {
          console.log(`  text:      ${JSON.stringify(part.text)}`);
        }
      }
    } else if (item.type === "function_call") {
      console.log(`  tool_call: ${item.name}(${item.arguments})  [call_id=${item.call_id}]`);
    } else if (item.type === "reasoning") {
      const summary = (item.summary || []).map((s) => s.text || "").join(" ");
      console.log(`  reasoning: ${summary.slice(0, 120)}${summary.length > 120 ? "..." : ""}`);
    } else {
      console.log(`  other:     ${item.type}`);
    }
  }

  console.log("\n✓ PASS");
}

main().catch((e) => {
  console.error("\n✗ FATAL:", e.message);
  process.exit(1);
});
