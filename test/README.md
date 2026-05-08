# Test harness

Two Node scripts that exercise the ChatGPT/Codex Responses endpoint
**without** going through Obsidian, so iteration on the
`chatgpt-oauth` provider doesn't require BRAT round-trips.

## One-time setup

```bash
node test/codex-login.mjs
```

Opens the Device Code Flow:

1. Opens the verification URL on `auth.openai.com/codex/device`.
2. Prints a short user code to enter on that page.
3. After you sign in with your ChatGPT account, polls until the token
   is issued and writes it to `temp/codex-token.json`.

`temp/` is gitignored — the credential never leaves your machine.

## Smoke test

```bash
node test/codex-smoke.mjs                       # default: gpt-5.5, "Say hello in one word."
node test/codex-smoke.mjs gpt-5.4                # different model
node test/codex-smoke.mjs gpt-5.5 "ziama"        # custom message
node test/codex-smoke.mjs gpt-5.5 "echo: hi" --tools  # also pass a function tool
node test/codex-smoke.mjs gpt-5.5 "what is the weather in nyc" --web-search
```

The script:

1. Loads the credential from `temp/codex-token.json`. Refreshes it via
   `auth.openai.com/oauth/token` if expired.
2. Builds the **exact** request body and headers the plugin sends from
   `src/api/chatgpt-oauth.ts` — same `originator`, `User-Agent`,
   `ChatGPT-Account-Id`, `store`, `parallel_tool_calls`, `reasoning`,
   `include`, etc.
3. POSTs to `chatgpt.com/backend-api/codex/responses` and parses the
   SSE response.
4. Prints HTTP status, parsed event types and counts, the final
   assistant text and any tool calls. Exits 0 on success, 1 on failure.

If this script passes against the real backend, the plugin will
behave the same way (modulo iOS-specific quirks like the lazy
`response.json` getter — those still need on-device verification).

## Why this exists

Each Codex error mode used to require: edit code → bump version →
build → tag → release → BRAT update → reproduce. That's ~5 minutes
per iteration of debugging *one error message*. With this harness
the loop is: edit code (or the script's body builder) → run script →
see the real server response in milliseconds. We only ship to
Obsidian once the smoke test is green.
