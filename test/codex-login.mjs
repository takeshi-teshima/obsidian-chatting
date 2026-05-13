/**
 * One-time ChatGPT Device Code Flow login for the smoke-test harness.
 *
 * Run once in this checkout:
 *
 *     node test/codex-login.mjs
 *
 * Prints a verification URL and a one-time code. Open the URL in any
 * browser, sign in with the ChatGPT account you want to test against,
 * enter the code, and come back. The script polls for completion and
 * writes the full credential (access + refresh + accountId) to
 * `temp/codex-token.json`. That file is gitignored.
 *
 * After this, run `node test/codex-smoke.mjs` to exercise the Codex
 * backend without going through Obsidian.
 *
 * Mirrors the auth logic in `src/auth/chatgptOAuth.ts` exactly so any
 * issue we find here applies to the Obsidian plugin too.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";

const ISSUER = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const VERIFICATION_URI = `${ISSUER}/codex/device`;
const TOKEN_PATH = "temp/codex-token.json";
const USER_AGENT = "chatting-with-ai/chatgpt-oauth-test";
const POLL_MARGIN_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64").toString("utf-8");
}

function parseJwtClaims(token) {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens) {
  for (const claims of [
    parseJwtClaims(tokens.id_token),
    parseJwtClaims(tokens.access_token),
  ]) {
    if (!claims) continue;
    const id =
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id;
    if (id) return id;
  }
  return undefined;
}

async function beginDeviceAuth() {
  const r = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!r.ok) {
    throw new Error(`usercode HTTP ${r.status}: ${await r.text()}`);
  }
  return r.json();
}

async function pollDeviceAuth(deviceAuthId, userCode, intervalMs) {
  while (true) {
    const r = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (r.status >= 200 && r.status < 300) {
      const data = await r.json();
      if (data.authorization_code && data.code_verifier) return data;
      throw new Error("Invalid token payload from device endpoint");
    }
    if (r.status !== 403 && r.status !== 404) {
      throw new Error(`poll HTTP ${r.status}: ${await r.text()}`);
    }
    await sleep(intervalMs + POLL_MARGIN_MS);
  }
}

async function exchangeCode(code, codeVerifier) {
  const r = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!r.ok) {
    throw new Error(`token exchange HTTP ${r.status}: ${await r.text()}`);
  }
  return r.json();
}

async function main() {
  console.log("──────────────────────────────────────────────");
  console.log("  ChatGPT Device Code Login — test harness");
  console.log("──────────────────────────────────────────────\n");

  const auth = await beginDeviceAuth();
  const intervalMs = (parseInt(auth.interval ?? "5", 10) || 5) * 1000;

  console.log("  1. Open this page in any browser:\n");
  console.log(`       ${VERIFICATION_URI}\n`);
  console.log("  2. Enter this code:\n");
  console.log(`       ${auth.user_code}\n`);
  console.log("  3. Sign in with the ChatGPT account you want to test against.\n");
  console.log("  Polling for completion (Ctrl-C to cancel)...\n");

  const dev = await pollDeviceAuth(auth.device_auth_id, auth.user_code, intervalMs);
  console.log("  Got authorization code, exchanging for tokens...");

  const tokens = await exchangeCode(dev.authorization_code, dev.code_verifier);
  const accountId = extractAccountId(tokens);

  const credential = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    updatedAt: Date.now(),
    ...(accountId ? { accountId } : {}),
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
  };

  await mkdir("temp", { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(credential, null, 2));

  console.log(`\n  ✓ Saved credential to ${TOKEN_PATH}`);
  if (accountId) {
    console.log(`    accountId: ${accountId}`);
  }
  console.log(`    expires:   ${new Date(credential.expiresAt).toLocaleString()}`);
  console.log("\n  Now run:  node test/codex-smoke.mjs");
}

main().catch((e) => {
  console.error("\n  ✗ FAILED:", e.message);
  process.exit(1);
});
