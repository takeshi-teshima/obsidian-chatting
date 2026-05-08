/**
 * Multi-turn smoke test — exercises the full agent-loop round trip:
 *
 *   Turn 1: user message + tool definition  →  model returns function_call
 *   Turn 2: user replays history + function_call + function_call_output
 *           (the way buildFullHistoryInput in chatgpt-oauth.ts would)
 *           →  model returns final text
 *
 * This catches bugs in:
 *   - encoding `function_call` items back into `input` (call_id / arguments)
 *   - encoding `function_call_output` items
 *   - sending the full history each turn (Codex doesn't store anything;
 *     `previous_response_id` is unavailable under `store: false`)
 *
 * Run after `node test/codex-login.mjs`:
 *   node test/codex-multi-turn.mjs [model]
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
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch {}
  }
  return events;
}

function reconstructOutput(events) {
  const itemByIndex = new Map();
  let completed = null;
  let failureMessage = null;
  for (const evt of events) {
    if (evt.type === "response.output_item.done" && evt.item) {
      const key = evt.output_index ?? evt.item.id ?? itemByIndex.size;
      itemByIndex.set(key, evt.item);
    } else if (evt.type === "response.completed") {
      completed = evt.response ?? {};
    } else if (evt.type === "response.failed") {
      failureMessage = evt.response?.error?.message ?? "response failed";
    } else if (evt.type === "error" && typeof evt.message === "string") {
      failureMessage = evt.message;
    }
  }
  if (failureMessage) throw new Error(failureMessage);
  return { output: Array.from(itemByIndex.values()), completed };
}

async function postCodex(credential, body) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: ORIGINATOR,
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const r = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 500)}`);
  }
  return reconstructOutput(parseSSE(text));
}

const ECHO_TOOL = {
  type: "function",
  name: "echo_back",
  description: "Echoes the user's text back. Always use this tool when the user asks to be echoed.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Text to echo." },
    },
    required: ["message"],
  },
  strict: false,
};

async function main() {
  const model = process.argv[2] || "gpt-5.5";
  const credential = await loadAndRefresh();

  // ─── Turn 1: ask the model to invoke the tool ─────────────────────
  console.log("─────────── Turn 1: send user message + tool ───────────");
  const turn1History = [
    {
      type: "message",
      role: "user",
      content: 'Please call the echo_back tool with message="ziama". After it returns, summarize what you echoed back in one short sentence.',
    },
  ];
  const body1 = {
    model,
    input: turn1History,
    instructions: "You are a test harness. When the user asks for an echo, call the echo_back tool.",
    store: false,
    parallel_tool_calls: true,
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    tools: [ECHO_TOOL],
  };
  const r1 = await postCodex(credential, body1);
  console.log(`  output items: ${r1.output.length}`);
  for (const it of r1.output) console.log(`    ${it.type}${it.type === "function_call" ? `: ${it.name}(${it.arguments})` : ""}`);

  const toolCall = r1.output.find((i) => i.type === "function_call");
  if (!toolCall) {
    console.log("\n  ✗ FAIL — model didn't call the tool.");
    process.exit(1);
  }
  console.log(`\n  ✓ got function_call: ${toolCall.name}, call_id=${toolCall.call_id}`);

  // ─── Turn 2: replay history including function_call + result ───────
  console.log("\n─────────── Turn 2: replay history with tool result ───────────");
  const args = JSON.parse(toolCall.arguments);
  const toolResultText = JSON.stringify({ echoed: args.message });

  const turn2History = [
    ...turn1History,
    // Replay the assistant's function_call exactly as it came back.
    {
      type: "function_call",
      call_id: toolCall.call_id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
    // Provide the tool's output.
    {
      type: "function_call_output",
      call_id: toolCall.call_id,
      output: toolResultText,
    },
  ];
  console.log(`  history items being sent: ${turn2History.length}`);
  for (const it of turn2History) console.log(`    ${it.type}${it.role ? ` (${it.role})` : ""}${it.name ? ` ${it.name}` : ""}`);

  const body2 = { ...body1, input: turn2History };
  const r2 = await postCodex(credential, body2);

  console.log(`\n  output items: ${r2.output.length}`);
  let assistantText = "";
  for (const it of r2.output) {
    if (it.type === "message" && Array.isArray(it.content)) {
      for (const part of it.content) {
        if (part.type === "output_text") {
          console.log(`    text: ${JSON.stringify(part.text)}`);
          assistantText += part.text;
        }
      }
    } else {
      console.log(`    ${it.type}`);
    }
  }

  if (!assistantText) {
    console.log("\n✗ FAIL — turn 2 returned no text response.");
    process.exit(1);
  }
  if (!assistantText.toLowerCase().includes("ziama")) {
    console.log("\n⚠ WARN — final text doesn't reference 'ziama'; round-trip may have lost the result.");
  }
  console.log("\n✓ PASS — multi-turn function-call round-trip works end-to-end.");
}

main().catch((e) => {
  console.error("\n✗ FATAL:", e.message);
  process.exit(1);
});
