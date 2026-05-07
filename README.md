# Obsidian Chatting

An agentic AI chat plugin for Obsidian. Three providers, mobile-first, no bloat.

<p align="center">
  <img src="assets/screenshot-mobile.jpeg" alt="Obsidian Chatting on mobile" width="300">
</p>

> **Author:** Yuxiao (o1xhack) — [GitHub](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
>
> **Upstream:** This project is downstream of [Obsidian Chat](https://github.com/omarshahine/obsidian-chat) by Omar Shahine. We track it as the `upstream` remote and pull improvements from it. See [License](#license) for attribution.

## Philosophy

Existing AI plugins for Obsidian are overcomplicated, break on mobile, or require a dozen settings to configure. Obsidian Chatting takes the opposite approach: pick a provider, sign in, start talking. The AI reads your notes, makes edits, creates files, and asks clarifying questions, all through a simple chat interface.

Mobile is a first-class citizen, not an afterthought.

## Providers

| Provider | Default Model | Auth | Features |
|----------|--------------|------|----------|
| Anthropic | Claude Sonnet 4.6 | API key | Adaptive thinking, web search, prompt caching |
| OpenAI | Codex 5.3 | API key | Responses API, reasoning, web search |
| ChatGPT OAuth | Codex 5.3 | OAuth (Device Code) | **Experimental.** Sign in with your ChatGPT account; routes through the ChatGPT/Codex backend. |

> **About ChatGPT OAuth:** This is an experimental provider that lets you skip the OpenAI API key by signing in with your ChatGPT account. It uses ChatGPT's own backend (not `api.openai.com`); availability, quotas, models, and request shapes may change without notice. The OpenAI API Key provider remains the recommended stable path. See [docs/chatgpt-oauth-plan.md](docs/chatgpt-oauth-plan.md) for design notes.

## What the AI can do

The chat assistant has 14 tools that map directly to Obsidian's Vault API:

- **read_document** / **read_file**: Read any note in your vault
- **edit_document**: Find-and-replace, insert, or replace content
- **search_vault**: Search filenames and content
- **create_file**: Create new notes with suggested paths
- **rename_file**: Rename or move files (updates all links)
- **delete_file**: Move files to trash
- **list_files**: Browse vault structure
- **open_document**: Navigate to a file in the editor
- **get_properties**: Read YAML frontmatter as structured data
- **set_properties**: Update frontmatter properties (uses Obsidian's native API)
- **get_backlinks**: Find all notes that link to a given document
- **get_current_datetime**: Get the current date and time in the user's locale
- **ask_user**: Ask you a question when something is ambiguous

The AI reads before it edits, prefers surgical find-and-replace over full rewrites, and acts on your confirmations without re-asking.

## Selection scope

Select text in a note, right-click, and choose "Send selection to Chat". The selection appears as a pill above the input. The AI works only within that selection, leaving the rest of the document untouched. Dismiss the pill to go back to full-document mode.

## Install

### Via BRAT (recommended while in beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. In BRAT settings, click **Add Beta plugin**.
3. Enter: `o1xhack/obsidian-chatting`
4. Enable **Obsidian Chatting** in Community Plugins.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/o1xhack/obsidian-chatting/releases).
2. Create `<vault>/.obsidian/plugins/obsidian-chatting/`.
3. Copy the files there.
4. Enable in Community Plugins.

## Setup

### Anthropic / OpenAI (API key)

1. Open **Settings → Obsidian Chatting**.
2. Pick **Anthropic** or **OpenAI**.
3. Enter your API key (stored per-provider in your OS keychain via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), never synced).
4. Click the refresh icon next to **Model** to load available models.
5. Open the chat from the ribbon icon, command palette, or context menu.

### ChatGPT OAuth (experimental)

1. Open **Settings → Obsidian Chatting**.
2. Pick **ChatGPT OAuth (Experimental)**.
3. Click **Connect ChatGPT**. The plugin shows a verification URL and a one-time `user_code`.
4. Open the URL in any browser, sign in with your ChatGPT account, and enter the code.
5. Return to Obsidian — the plugin polls for completion and stores the credential in [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage).
6. Open the chat. Tokens auto-refresh; if refresh fails you'll see a clear "session expired, reconnect" notice.

## Commands

| Command | Description |
|---------|-------------|
| Open chat | Open the chat sidebar |
| Chat about this note | Send the active note to chat (editor required) |
| Send selection to Chat | Send selected text with scoped context |
| Copy conversation transcript | Export the full conversation to clipboard |
| Clear conversation | Reset the chat |

## Context menus

- **File explorer**: Right-click any markdown file → **Chat about this note**.
- **Editor**: Right-click selected text → **Send selection to Chat**.
- **Ribbon icon**: Right-click for quick actions menu.

## Design decisions

| Decision | Why |
|----------|-----|
| Three providers only | Anthropic + OpenAI for stable use, ChatGPT OAuth as an experimental third option. |
| No streaming | Obsidian's `requestUrl()` can't expose a streaming body. Required for mobile compatibility. |
| Device Code Flow for OAuth | No localhost callback server needed → works on mobile Obsidian. |
| Conversation persistence | Chat history survives Obsidian restarts. Stored locally in `chat-state.json`, never synced. |
| No vault indexing | Linear search capped at results limit. Avoids mobile memory issues. |
| Svelte 5 UI | Compiles away to vanilla JS. Reactive state without React's runtime overhead. |
| Right sidebar on mobile | Slides in from the edge, keeping your document underneath. |
| Per-device secrets | API keys *and* OAuth credentials live in the OS keychain via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage). Never synced, never in `data.json`. |

## Development

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

Symlink into your vault for testing:

```bash
ln -s /path/to/obsidian-chatting /path/to/vault/.obsidian/plugins/obsidian-chatting
```

### Syncing from upstream

This repo tracks [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat) as `upstream`:

```bash
git remote -v                       # upstream → omarshahine/obsidian-chat
git fetch upstream
git merge upstream/main             # or: git rebase upstream/main
```

## License

MIT. See [LICENSE](./LICENSE).

This project is downstream of [Obsidian Chat](https://github.com/omarshahine/obsidian-chat) by Omar Shahine, also MIT-licensed. The `LICENSE` file preserves the upstream copyright notice alongside our own.
