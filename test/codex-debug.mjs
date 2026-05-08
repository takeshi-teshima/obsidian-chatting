/**
 * Debug variant of codex-smoke.mjs — dumps every SSE event raw.
 * Use this to inspect the exact shape Codex sends back.
 */
import { readFile, writeFile } from "node:fs/promises";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const TOKEN_PATH = "temp/codex-token.json";
const ORIGINATOR = "opencode";
const USER_AGENT = "OpenAI/JS 4.x obsidian-chatting/0.1";

async function loadAndRefresh() {
  const credential = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  if (credential.expiresAt > Date.now() + 30000) return credential;
  const r = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  const tokens = await r.json();
  const next = {
    ...credential,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    updatedAt: Date.now(),
  };
  await writeFile(TOKEN_PATH, JSON.stringify(next, null, 2));
  return next;
}

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
    try { events.push(JSON.parse(payload)); } catch {}
  }
  return events;
}

async function main() {
  const model = process.argv[2] || "gpt-5.5";
  const message = process.argv[3] || "Say hello in one word.";

  const credential = await loadAndRefresh();
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: ORIGINATOR,
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const body = {
    model,
    input: [{ type: "message", role: "user", content: message }],
    instructions: "You are a test harness. Respond briefly.",
    store: false,
    parallel_tool_calls: true,
    stream: true,
  };
  if (/^o\d|^gpt-5|codex/i.test(model)) {
    body.reasoning = { effort: "medium", summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }

  const r = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`HTTP ${r.status}, ${text.length} bytes`);

  const events = parseSSE(text);
  console.log(`\nGot ${events.length} events. Full dump:\n`);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    console.log(`──────── event #${i} (${e.type || "?"}) ────────`);
    console.log(JSON.stringify(e, null, 2));
    console.log();
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
