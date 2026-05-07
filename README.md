# Obsidian Chatting

**Chat with your vault. On any device. With the model of your choice.**

<p align="center">
  <img src="assets/screenshot-mobile.jpeg" alt="Obsidian Chatting on mobile" width="320">
</p>

<p align="center">
  English ·
  <a href="docs/i18n/README.zh-CN.md">简体中文</a> ·
  <a href="docs/i18n/README.zh-TW.md">繁體中文</a> ·
  <a href="docs/i18n/README.ja.md">日本語</a>
</p>

<p align="center">
  by <strong>Yuxiao (o1xhack)</strong> ·
  <a href="https://github.com/o1xhack">GitHub</a> ·
  <a href="https://app.o1xhack.com">app.o1xhack.com</a>
</p>

---

## Why Obsidian Chatting

Most AI plugins for Obsidian are heavy. They have a dozen settings before you can ask your first question, they break on phones, and they treat the AI as a chatbot rather than an assistant that can act on your notes.

Obsidian Chatting is the opposite:

- **Mobile-first.** Works the same on iOS, Android, and desktop.
- **Three providers, you pick.** Anthropic API, OpenAI API, or sign in with your ChatGPT account.
- **Agentic by default.** The assistant reads, edits, creates, and renames notes through 14 vault-native tools — not just chat.
- **Your secrets stay yours.** API keys and OAuth tokens live in the OS keychain, never in `data.json`, never synced.

## Providers

| Provider | Auth | Default model | Notes |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | Adaptive thinking, web search, prompt caching. |
| **OpenAI** | API key | Codex 5.3 | Responses API, reasoning, web search. |
| **ChatGPT OAuth** *(experimental)* | Sign in with ChatGPT | Codex 5.3 | Use your ChatGPT account instead of an API key. Routes through the ChatGPT/Codex backend; availability and quotas are subject to change. |

> **About the experimental provider:** ChatGPT OAuth talks to the ChatGPT/Codex backend (not `api.openai.com`). The OpenAI API Key provider remains the recommended stable path. See [docs/chatgpt-oauth-plan.md](docs/chatgpt-oauth-plan.md) for design notes.

## What it can do for your vault

The assistant has 14 tools wired straight into Obsidian's Vault API:

- Read any note (or any file).
- Edit a note via surgical find-and-replace, insert, or full replace.
- Search filenames and content.
- Create new notes with a suggested path.
- Rename or move files (links update automatically).
- Move files to trash.
- Browse vault structure.
- Open a file in the editor.
- Read and update YAML frontmatter properties.
- Find backlinks for any note.
- Get the current date/time in your locale.
- Ask you a follow-up question when something is ambiguous.

It reads before it edits, prefers small surgical changes over rewrites, and acts on your confirmations without re-asking.

## Selection scope

Highlight text in a note, right-click, choose **Send selection to Chat**. The selection becomes a pill above the input, and the assistant works only inside it — leaving the rest of the document untouched.

## Install

### Via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. **Add Beta plugin** → enter `o1xhack/obsidian-chatting`.
3. Enable **Obsidian Chatting** in Community Plugins.

That's the only supported install path right now. A Community Plugins listing is on the roadmap.

## Setup

Open **Settings → Obsidian Chatting**, pick a provider, then:

- **Anthropic / OpenAI:** paste your API key. The plugin stores it in the OS keychain (via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage)).
- **ChatGPT OAuth:** click **Connect ChatGPT**. A modal shows a verification URL and a one-time code. Open the URL in any browser, sign in, enter the code, and come back. Tokens auto-refresh; if a refresh ever fails you'll see a clear *"session expired, reconnect"* notice.

That's it. Open the chat from the ribbon icon or the command palette.

## Design principles

| Principle | What it means |
|---|---|
| **Mobile is not an afterthought** | Every change is validated on mobile. No streaming, no Node-only modules, no localhost callbacks. |
| **Three sane providers, no bloat** | Anthropic + OpenAI for stability, ChatGPT OAuth for users who want to skip the API key. No marketplace of half-broken providers. |
| **Secrets in the keychain** | API keys and OAuth credentials go through Obsidian SecretStorage. They never land in `data.json`, so they never sync to other devices. |
| **No vault indexing** | Linear search, capped. Predictable, no background work, no memory pressure on phones. |
| **Conversation persists** | Chat history survives Obsidian restarts. Stored locally in `chat-state.json`, never synced. |
| **Right sidebar on mobile** | Slides in from the edge — your document stays visible underneath. |

## Development

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

Symlink into a test vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/obsidian-chatting
```

## License

[MIT](./LICENSE). Originally derived from [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat) (also MIT) — the original copyright is preserved in `LICENSE` for attribution. Obsidian Chatting is now an independent project with its own roadmap.
