# Obsidian Chatting

> An agentic AI assistant for your Obsidian vault — same experience on phone, tablet, and desktop.

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

<p align="center">
  <img src="assets/screenshot-settings.png" alt="Provider settings on iPhone" width="260">
  <img src="assets/screenshot-chat-cn.png" alt="Web search powered answer in Chinese" width="260">
  <img src="assets/screenshot-chat-en.png" alt="Clean answer in English with bullet list" width="260">
</p>

---

## Highlights

- **Three providers, your choice** — Anthropic API, OpenAI API, or sign in with your ChatGPT account.
- **14 vault-native tools** — read, edit, search, create, rename, frontmatter, backlinks, and more.
- **Mobile-parity** — no streaming, no Node-only modules, no localhost callbacks. iOS and Android behave the same as desktop.
- **Selection scope** — highlight text, send it to chat, the assistant edits only inside the selection.
- **Secrets in the OS keychain** — never in `data.json`, never synced across devices.

## Providers

| Provider | Auth | Default model | Notes |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | Adaptive thinking, web search, prompt caching. |
| **OpenAI** | API key | Codex 5.3 | Responses API, reasoning, web search. |
| **ChatGPT account** | Sign in with ChatGPT | GPT-5.5 | Uses your ChatGPT plan instead of an OpenAI API key. |

> **About ChatGPT account login.** This provider signs you in with your ChatGPT account and routes requests through the ChatGPT/Codex backend (not `api.openai.com`). It requires an active ChatGPT plan with Codex access. The available models mirror the Codex CLI catalog.

## What the agent can do

The assistant has direct access to your vault through 14 tools, grouped by what they touch:

**Read**
- `read_document`, `read_file` — open any note or any vault file.
- `search_vault` — search filenames and note content.
- `list_files` — browse the vault tree.
- `get_backlinks` — find notes linking to a given note.
- `get_properties` — read YAML frontmatter.
- `get_current_datetime` — current date/time in your locale.

**Write**
- `edit_document` — surgical find-and-replace, insert, or full replace.
- `create_file` — create a new note with a suggested path (parent folders auto-created).
- `set_properties` — safe YAML frontmatter merge / remove.

**Manage**
- `rename_file` — rename or move; links update automatically.
- `delete_file` — move to trash (respects your trash setting).
- `open_document` — open a file in the editor.
- `ask_user` — pause and ask you when something is ambiguous.

The assistant reads before it edits, prefers small surgical changes over rewrites, and does not re-ask once you confirm an action.

## Selection scope

Highlight text in any note, right-click, choose **Send selection to Chat**. The selection becomes a pill above the input, and the assistant edits only inside the selected range — leaving the rest of the document untouched.

## Quickstart

**1. Install via BRAT**

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins, then **Add Beta plugin** → enter `o1xhack/obsidian-chatting`. Enable **Obsidian Chatting** in Community Plugins.

**2. Pick a provider in Settings → Obsidian Chatting**

- **Anthropic / OpenAI** — paste your API key. Stored in the OS keychain via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage).
- **ChatGPT account** — click **Connect ChatGPT**. A modal shows a verification URL and a one-time code. Open the URL in any browser, sign in, enter the code. Tokens auto-refresh; if a refresh ever fails you'll see a clear *"session expired, reconnect"* notice.

**3. Open the chat**

Use the ribbon icon or the command palette.

## Design principles

| Principle | What it means |
|---|---|
| **Mobile is not an afterthought** | Every change is validated on iOS and Android. No streaming, no Node-only modules, no localhost callbacks. |
| **Three sane providers** | Anthropic + OpenAI for stability, ChatGPT account for users who'd rather not manage an API key. No marketplace of half-broken providers. |
| **Secrets in the keychain** | API keys and OAuth credentials go through Obsidian SecretStorage. They never land in `data.json`, so they never sync to other devices. |
| **No vault indexing** | Linear search, capped. Predictable, no background work, no memory pressure on phones. |
| **Conversation persists** | Chat history survives Obsidian restarts. Stored locally in `chat-state.json`, never synced. |
| **Right sidebar on mobile** | Slides in from the edge — your document stays visible underneath. |

## Roadmap

No promises on order, but on the radar:

- Submission to the official Obsidian Community Plugins listing.
- Multi-conversation history with archive / search.
- Image attachments where the provider supports them.
- More upstream provider models picked up automatically as they ship.

Have a request? Open an issue.

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
