import {
  Plugin,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, SelectionScope, UnifiedMessage } from "./types";
import { DEFAULT_SETTINGS, CHATGPT_OAUTH_DEFAULT_MODEL } from "./types";
import { ChatSettingTab, getModelDisplayName } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { AgentLoop } from "./agent/loop";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { ObsidianSessionStorageAdapter } from "./sessions/obsidian-storage-adapter";
import { ObsidianLegacyReadAdapter } from "./sessions/obsidian-legacy-read-adapter";
import { SessionMetadataStore } from "./sessions/metadata/store";
import { ChattingHistoryStore } from "./sessions/history/store";
import { SessionIndexStore } from "./sessions/index/store";
import { createSessionMetadata } from "./sessions/metadata/factory";
import { toConversationMeta } from "./sessions/index/derived-index";
import { runMigration } from "./sessions/migration/run-migration";
import { loadActiveSessionId, saveActiveSessionId } from "./sessions/runtime/active-session";
import { deriveDisplayHistory, type DisplayEntry } from "./sessions/display-history";

const PLUGIN_ID = "chatting-with-ai";
const LEGACY_PLUGIN_ID = "obsidian-chatting";
const LEGACY_RELEASE_ASSETS = new Set(["main.js", "manifest.json", "styles.css"]);
const SECRET_PROVIDERS = ["anthropic", "openai", "chatgpt-oauth"];
const CHATGPT_OAUTH_SECRET_KEY = `${PLUGIN_ID}-chatgpt-oauth`;
const LEGACY_CHATGPT_OAUTH_SECRET_KEY = `${LEGACY_PLUGIN_ID}-chatgpt-oauth`;

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /** Shared agent loop that persists across view open/close cycles */
  agent!: AgentLoop;
  /** ChatGPT OAuth service (used by the chatgpt-oauth provider). */
  chatgptOAuth!: ChatGPTOAuthService;
  /** Chat messages for replaying into the UI when the view reopens. Display-only,
   * re-derived from canonical UnifiedMessage history — see sessions/display-history.ts. */
  chatHistory: DisplayEntry[] = [];

  /** Session Workspaces v4 canonical storage (`.chatting/...` at the vault root). */
  private sessionAdapter!: ObsidianSessionStorageAdapter;
  private metadataStore!: SessionMetadataStore;
  private historyStore!: ChattingHistoryStore;
  private indexStore!: SessionIndexStore;
  /**
   * Id of the single session this plugin's one visible chat pane is bound
   * to. See sessions/runtime/active-session.ts for why this is NOT part of
   * SessionMetadata, and the migration report for why multi-session
   * concurrent binding (v3's SessionManager/SessionSwitcher) was not
   * re-ported in this pass.
   */
  private activeSessionId!: string;

  async onload(): Promise<void> {
    await this.migrateLegacyPluginData();
    await this.loadSettings();

    // Wire ChatGPT OAuth before constructing the agent: the OAuth API client
    // looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);

    this.agent = new AgentLoop(this.app, this.settings);

    this.sessionAdapter = new ObsidianSessionStorageAdapter(this.app);
    this.metadataStore = new SessionMetadataStore(this.sessionAdapter);
    this.historyStore = new ChattingHistoryStore(this.sessionAdapter);
    this.indexStore = new SessionIndexStore(this.sessionAdapter);

    // Restore persisted chat history (runs v3/branch-11/legacy migration
    // into `.chatting/` canonical storage on first run; idempotent after).
    await this.loadChatHistory();

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Chatting with AI", (evt) => {
      if (evt.type === "contextmenu" || evt.button === 2) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => void this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => void this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt);
      } else {
        void this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.openChat(),
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    this.addCommand({
      id: "reload-conversation-from-disk",
      name: "Reload conversation from disk (recovery)",
      callback: () => void this.reloadActiveSessionFromDisk(),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        void this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to Chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope: SelectionScope = { text: sel, filePath: ctx.file?.path ?? "" };
        void this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === "md") {
          menu.addItem((item) =>
            item
              .setTitle("Chat about this note")
              .setIcon("message-circle")
              .onClick(() => void this.openChatWithMessage(`Tell me about ${file.path}`))
          );
        } else if (file.extension.toLowerCase() === "pdf") {
          menu.addItem((item) =>
            item
              .setTitle("Chat about this PDF")
              .setIcon("file-search")
              .onClick(() =>
                void this.openChatWithMessage(
                  `Inspect ${file.path} using the local PDF tools. Start with pdf_info or pdf_search; read only the pages needed for my question.`
                )
              )
          );
        }
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Chat")
              .setIcon("message-circle")
              .onClick(() => {
                const scope: SelectionScope = { text: sel, filePath: info.file?.path ?? "" };
                void this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  onunload(): void {
    void this.saveChatHistory();
  }

  // ─── Chat operations ────────────────────────────────────────────────

  /**
   * True if the active provider is configured enough to send a message.
   * - anthropic / openai: an API key is set.
   * - chatgpt-oauth: a credential is present in SecretStorage.
   */
  private isProviderConfigured(): boolean {
    if (this.settings.provider === "chatgpt-oauth") {
      return !!this.chatgptOAuth?.getCredential();
    }
    return !!this.settings.apiKey;
  }

  private notConfiguredMessage(): string {
    if (this.settings.provider === "chatgpt-oauth") {
      return "Connect your ChatGPT account in Chatting with AI settings.";
    }
    return "Please configure your API key in Chatting with AI settings.";
  }

  private async openChat(): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
  }

  /** Open chat and immediately send a message */
  private async openChatWithMessage(message: string): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      window.setTimeout(() => view.sendMessage(message), 100);
    }
  }

  /** Open chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      window.setTimeout(() => {
        view.setSelection(selection);
        view.focus();
      }, 100);
    }
  }

  private async chatAboutActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    await this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /** Open or reveal the chat view in the right sidebar (both desktop and mobile). */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }

    // Right sidebar on both desktop and mobile.
    // On mobile, this slides in as a panel from the right edge.
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      await workspace.revealLeaf(leaf);
    }
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  private async shareTranscript(): Promise<void> {
    const view = this.getChatView();
    if (!view) {
      new Notice("No active conversation.");
      return;
    }

    const transcript = await view.getTranscript();
    if (!transcript || transcript.endsWith("## Conversation\n\n")) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  private clearChat(): void {
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
    }
  }

  // ─── Session Workspaces v4 persistence ─────────────────────────────────
  //
  // Canonical storage is `.chatting/session-metadata/<id>.meta.json` +
  // `.chatting/sessions/<id>.jsonl` (Claudian-shaped metadata + Chatting-
  // native UnifiedMessage JSONL transcript). See src/sessions/ and
  // MIGRATION_HANDOFF.md / MERGE_INSTRUCTIONS.md for the full contract.

  /** Persist the active session's transcript + metadata after a turn. */
  async saveChatHistory(): Promise<void> {
    try {
      const messages = this.agent.exportMessages();
      await this.historyStore.replace(this.activeSessionId, messages);

      const loaded = await this.metadataStore.load(this.activeSessionId);
      const now = Date.now();
      const metadata = loaded?.metadata ?? createSessionMetadata({
        id: this.activeSessionId,
        historyPath: this.historyStore.pathFor(this.activeSessionId),
      });
      metadata.lastActivityAt = now;
      if (!metadata.title || metadata.title === "New chat") {
        metadata.title = deriveTitleFromMessages(messages) ?? metadata.title ?? "New chat";
      }
      metadata.selectedModel = this.settings.model;
      metadata.providerState = {
        ...(metadata.providerState ?? {}),
        history: {
          format: "unified-message-jsonl",
          schemaVersion: 1,
          path: this.historyStore.pathFor(this.activeSessionId),
          revision: (((metadata.providerState as { history?: { revision?: number } } | undefined)?.history?.revision) ?? 0) + 1,
        },
        upstreamProvider: this.settings.provider,
        profileId: this.settings.activeProfileId,
        reasoningEffort: this.settings.reasoningEffort,
      };
      await this.metadataStore.save(metadata, loaded?.unknownFields);

      await this.indexStore.upsert(
        toConversationMeta(metadata, {
          messageCount: messages.length,
          preview: derivePreviewFromMessages(messages),
        }),
      );
    } catch {
      // Persistence is best-effort, matching the previous chat-state.json behavior.
    }
  }

  /**
   * Boot-time restore: runs the (idempotent, non-destructive) v3/branch-11/
   * legacy-chat-state migration into `.chatting/` canonical storage, then
   * loads whichever session is active into the in-memory agent + display
   * history.
   */
  async loadChatHistory(): Promise<void> {
    try {
      const summary = await runMigration({
        canonicalAdapter: this.sessionAdapter,
        legacyAdapter: new ObsidianLegacyReadAdapter(this.app),
        pluginDataDir: this.pluginDataDir,
        legacyChatStatePaths: [this.chatStatePath, this.legacyChatStatePath],
        currentProvider: this.settings.provider,
        currentModel: this.settings.model,
      });
      if (summary.migratedCount > 0 || summary.failedCount > 0) {
        const parts = [`Session Workspaces v4: migrated ${summary.migratedCount} conversation(s).`];
        if (summary.failedCount > 0) parts.push(`${summary.failedCount} failed — see console.`);
        new Notice(parts.join(" "));
        if (summary.failedCount > 0) {
          console.warn("[chatting-with-ai] migration diagnostics", summary.diagnostics);
        }
      }
    } catch (error) {
      console.error("[chatting-with-ai] v4 migration failed to run", error);
    }

    this.activeSessionId = await this.resolveActiveSessionId();
    await this.hydrateFromActiveSession();
  }

  /**
   * Explicit "reload this session from disk" recovery path (see the plugin
   * brief's "restore the reload-from-disk recovery feature under the new
   * schema" requirement). Re-reads `.chatting/sessions/<id>.jsonl` fresh,
   * fully replaces in-memory history (never merges), resets provider
   * continuation state, re-derives + persists lastActivityAt/preview/
   * messageCount-equivalent metadata, and re-renders the bound view.
   */
  async reloadActiveSessionFromDisk(): Promise<void> {
    const view = this.getChatView();
    if (view?.isRunning()) {
      new Notice("Can't reload from disk while a response is in progress. Stop it first.");
      return;
    }

    try {
      const freshMessages = await this.historyStore.load(this.activeSessionId);
      this.agent.importMessages(freshMessages);
      this.agent.resetContinuationState();
      this.chatHistory = deriveDisplayHistory(freshMessages);

      const loaded = await this.metadataStore.load(this.activeSessionId);
      if (loaded) {
        loaded.metadata.lastActivityAt = Date.now();
        await this.metadataStore.save(loaded.metadata, loaded.unknownFields);
        await this.indexStore.upsert(
          toConversationMeta(loaded.metadata, {
            messageCount: freshMessages.length,
            preview: derivePreviewFromMessages(freshMessages),
          }),
        );
      }

      view?.rerenderFromPluginState();
      new Notice("Conversation reloaded from disk.");
    } catch (error) {
      new Notice(`Reload from disk failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Load the active session's transcript into the agent + display history. */
  private async hydrateFromActiveSession(): Promise<void> {
    const messages = await this.historyStore.load(this.activeSessionId);
    this.agent.importMessages(messages);
    this.chatHistory = deriveDisplayHistory(messages);
  }

  /**
   * Picks which session the single visible pane binds to on startup: the
   * previously-bound session if it still exists, otherwise the
   * most-recently-active non-archived migrated session, otherwise a fresh
   * blank v4 session. Mirrors MIGRATION_HANDOFF.md §5's "old activeSessionId
   * may be used once to select the initial migrated session/view binding".
   */
  private async resolveActiveSessionId(): Promise<string> {
    const remembered = await loadActiveSessionId(this.sessionAdapter);
    if (remembered && await this.metadataStore.load(remembered)) {
      return remembered;
    }

    const all = await this.metadataStore.list();
    const candidate = all.find((entry) => !entry.metadata.isArchived) ?? all[0];
    const resolved = candidate
      ? candidate.metadata.id
      : await this.createBlankSession();

    await saveActiveSessionId(this.sessionAdapter, resolved);
    return resolved;
  }

  private async createBlankSession(): Promise<string> {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const metadata = createSessionMetadata({
      id,
      title: "New chat",
      selectedModel: this.settings.model,
      upstreamProvider: this.settings.provider,
      historyPath: this.historyStore.pathFor(id),
      profileId: this.settings.activeProfileId,
      reasoningEffort: this.settings.reasoningEffort,
    });
    await this.historyStore.replace(id, []);
    await this.metadataStore.save(metadata);
    await this.indexStore.upsert(toConversationMeta(metadata, { messageCount: 0, preview: "" }));
    return id;
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = normalizeSettings(await this.loadData());
    this.settings = { ...DEFAULT_SETTINGS, ...saved };

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    // Migrate ChatGPT OAuth model slugs that an earlier release wrote with
    // dash-form versions (`gpt-5-5`, `gpt-5-2`, …). The Codex backend only
    // accepts dotted slugs (`gpt-5.5`, `gpt-5.2`, …) and rejects the
    // dash form with HTTP 400. We rewrite in place and persist back.
    if (this.settings.provider === "chatgpt-oauth") {
      const migrated = migrateChatGPTOAuthModelSlug(this.settings.model);
      if (migrated !== this.settings.model) {
        this.settings.model = migrated;
        // Best-effort save; ignore errors during initial load
        this.saveData({ ...this.settings, apiKey: "" }).catch(() => {});
      }
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);

    // Update the chat view header with the new model name
    this.getChatView()?.updateModel(
      getModelDisplayName(this.settings.provider, this.settings.model)
    );
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  private loadApiKey(provider: string): string {
    try {
      return (
        this.app.secretStorage.getSecret(`${PLUGIN_ID}-api-key-${provider}`) ||
        this.app.secretStorage.getSecret(`${LEGACY_PLUGIN_ID}-api-key-${provider}`) ||
        ""
      );
    } catch {
      return "";
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`${PLUGIN_ID}-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }

  private async migrateLegacyPluginData(): Promise<void> {
    await this.migrateLegacyDataFiles();
    this.migrateLegacySecrets();
  }

  private async migrateLegacyDataFiles(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.legacyPluginDataDir))) return;
      await this.ensureFolder(this.pluginDataDir);
      await this.copyLegacyPluginDataDir(this.legacyPluginDataDir, this.pluginDataDir, true);

      await adapter.rmdir(this.legacyPluginDataDir, true);
    } catch {
      // Migration is best-effort; legacy fallback reads still protect users.
    }
  }

  private async copyLegacyPluginDataDir(fromDir: string, toDir: string, isRoot: boolean): Promise<void> {
    const adapter = this.app.vault.adapter;
    const listed = await adapter.list(fromDir);

    for (const folder of listed.folders) {
      const name = folder.split("/").pop();
      if (!name) continue;
      const target = `${toDir}/${name}`;
      await this.ensureFolder(target);
      await this.copyLegacyPluginDataDir(folder, target, false);
    }

    for (const file of listed.files) {
      const name = file.split("/").pop();
      if (!name) continue;
      if (isRoot && LEGACY_RELEASE_ASSETS.has(name)) continue;

      const target = `${toDir}/${name}`;
      if (!(await adapter.exists(target))) {
        await adapter.writeBinary(target, await adapter.readBinary(file));
      }
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    try {
      await adapter.mkdir(path);
    } catch {
      // Another plugin startup path may have created it first.
    }
  }

  private migrateLegacySecrets(): void {
    for (const provider of SECRET_PROVIDERS) {
      this.migrateSecret(
        `${PLUGIN_ID}-api-key-${provider}`,
        `${LEGACY_PLUGIN_ID}-api-key-${provider}`,
      );
    }
    this.migrateSecret(CHATGPT_OAUTH_SECRET_KEY, LEGACY_CHATGPT_OAUTH_SECRET_KEY);
  }

  private migrateSecret(currentKey: string, legacyKey: string): void {
    try {
      const currentValue = this.app.secretStorage.getSecret(currentKey);
      const legacyValue = this.app.secretStorage.getSecret(legacyKey);
      if (legacyValue && !currentValue) {
        this.app.secretStorage.setSecret(currentKey, legacyValue);
      }
      if (legacyValue) {
        this.app.secretStorage.setSecret(legacyKey, "");
      }
    } catch {
      // SecretStorage may be unavailable on very old Obsidian versions.
    }
  }

  private get pluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  private get legacyPluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`;
  }

  private get chatStatePath(): string {
    return `${this.pluginDataDir}/chat-state.json`;
  }

  private get legacyChatStatePath(): string {
    return `${this.legacyPluginDataDir}/chat-state.json`;
  }
}

function deriveTitleFromMessages(messages: readonly UnifiedMessage[]): string | undefined {
  const first = messages.find((m) => m.role === "user");
  if (!first) return undefined;
  const text = typeof first.content === "string"
    ? first.content
    : first.content.find((b) => b.type === "text" && b.text)?.text ?? "";
  const clean = text.replace(/^\[Context:[^\]]*\]\n\n/, "").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length <= 64 ? clean : `${clean.slice(0, 61).trimEnd()}...`;
}

function derivePreviewFromMessages(messages: readonly UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const text = typeof message.content === "string"
      ? message.content
      : message.content.find((b) => b.type === "text" && b.text)?.text ?? "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) return clean.length <= 120 ? clean : `${clean.slice(0, 117).trimEnd()}...`;
  }
  return "";
}

function normalizeSettings(value: unknown): Partial<ChatSettings> {
  if (!isRecord(value)) return {};
  const settings: Partial<ChatSettings> = {};
  if (isProvider(value.provider)) settings.provider = value.provider;
  if (typeof value.apiKey === "string") settings.apiKey = value.apiKey;
  if (typeof value.model === "string") settings.model = value.model;
  if (typeof value.maxIterations === "number") settings.maxIterations = value.maxIterations;
  if (typeof value.enableWebSearch === "boolean") settings.enableWebSearch = value.enableWebSearch;
  if (isReasoningEffort(value.reasoningEffort)) settings.reasoningEffort = value.reasoningEffort;
  if (typeof value.customInstructions === "string") settings.customInstructions = value.customInstructions;
  if (typeof value.activeProfileId === "string" && value.activeProfileId.trim()) {
    settings.activeProfileId = value.activeProfileId;
  } else {
    settings.activeProfileId = null;
  }
  return settings;
}

function isProvider(value: unknown): value is ChatSettings["provider"] {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth";
}

function isReasoningEffort(value: unknown): value is ChatSettings["reasoningEffort"] {
  return (
    value === "auto" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ─── Settings migrations ─────────────────────────────────────────────────────

/**
 * Migrate a saved ChatGPT OAuth model slug to a Codex-backend-compatible form.
 *
 * Background: 0.1.0 fetched the model list from `chatgpt.com/backend-api/models`
 * (the chat.com UI catalog) as a fallback. That endpoint returns dash-form
 * slugs like `gpt-5-5`, `gpt-5-2-pro` — which the Codex `/responses` endpoint
 * rejects with HTTP 400 ("model is not supported when using Codex with a
 * ChatGPT account"). 0.1.1+ uses the canonical Codex catalog, but settings
 * persisted before the upgrade still hold the broken slugs.
 *
 * Migration rules:
 *   - `gpt-5-N`           → `gpt-5.N`            (dash to dot version)
 *   - `gpt-5-N-codex`     → `gpt-5.N-codex`
 *   - `gpt-5-N-mini`      → `gpt-5.N-mini`
 *   - any other UI-catalog slug not on the known-good list → reset to the
 *     canonical default (`gpt-5.5`).
 */
const KNOWN_GOOD_OAUTH_SLUGS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
]);

function migrateChatGPTOAuthModelSlug(slug: string): string {
  if (!slug) return CHATGPT_OAUTH_DEFAULT_MODEL;
  if (KNOWN_GOOD_OAUTH_SLUGS.has(slug)) return slug;

  // Replace `gpt-5-N` (single-digit version after the model number) with
  // `gpt-5.N`. Tail can be `-codex`, `-mini`, etc. We only touch the version
  // dash, not other dashes — so `gpt-5-mini` (which means a *mini variant*,
  // not a sub-version) stays put and falls through to the default.
  const dashVersion = slug.match(/^gpt-(5)-(\d+)(.*)$/);
  if (dashVersion) {
    const candidate = `gpt-${dashVersion[1]}.${dashVersion[2]}${dashVersion[3]}`;
    if (KNOWN_GOOD_OAUTH_SLUGS.has(candidate)) return candidate;
  }

  // Anything else (gpt-5-mini, gpt-5-5-pro, agent, deep-research, o3, …) isn't
  // valid on the Codex backend. Reset to the safe default.
  return CHATGPT_OAUTH_DEFAULT_MODEL;
}
