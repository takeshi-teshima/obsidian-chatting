import {
  Plugin,
  Notice,
  Platform,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, SelectionScope } from "./types";
import { DEFAULT_SETTINGS, CHATGPT_OAUTH_DEFAULT_MODEL } from "./types";
import { ChatSettingTab, getModelDisplayName } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { AgentLoopSessionAdapter } from "./agent/session-adapter";
import { SessionStore } from "./session/store";
import { SessionManager, preferencesFromSettings, type SessionAgentFactory } from "./session/manager";
import { showBackgroundSessionNotice } from "./session/background-notice";
import type { PersistedSession } from "./session/types";

const PLUGIN_ID = "chatting-with-ai";
const LEGACY_PLUGIN_ID = "obsidian-chatting";
const LEGACY_RELEASE_ASSETS = new Set(["main.js", "manifest.json", "styles.css"]);
const SECRET_PROVIDERS = ["anthropic", "openai", "chatgpt-oauth"];
const CHATGPT_OAUTH_SECRET_KEY = `${PLUGIN_ID}-chatgpt-oauth`;
const LEGACY_CHATGPT_OAUTH_SECRET_KEY = `${LEGACY_PLUGIN_ID}-chatgpt-oauth`;

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /** ChatGPT OAuth service (used by the chatgpt-oauth provider). */
  chatgptOAuth!: ChatGPTOAuthService;

  /**
   * Session Workspaces storage/orchestration. There is deliberately no
   * plugin-global "active session" or plugin-global AgentLoop: each
   * ObsidianChatView binds independently to a session id, and each
   * hydrated SessionRuntime owns exactly one agent adapter. See
   * src/session/manager.ts and MERGE_INSTRUCTIONS.md.
   */
  sessionStore!: SessionStore;
  sessionManager!: SessionManager;

  async onload(): Promise<void> {
    await this.migrateLegacyPluginData();
    await this.loadSettings();

    // Wire ChatGPT OAuth before constructing any agent adapters: the OAuth
    // API client looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);

    this.sessionStore = new SessionStore(this.app, PLUGIN_ID);
    await this.sessionStore.initialize({
      legacyChatStatePaths: [this.chatStatePath, this.legacyChatStatePath],
      defaultPreferences: preferencesFromSettings(this.settings),
    });

    const agentFactory: SessionAgentFactory = {
      create: (session: PersistedSession) =>
        new AgentLoopSessionAdapter(this.app, this.settingsForSession(session)),
    };

    this.sessionManager = new SessionManager({
      store: this.sessionStore,
      agentFactory,
      getDefaultPreferences: () => preferencesFromSettings(this.settings),
      maxConcurrentRuns: this.resolveMaxConcurrentSessions(),
      maxHydratedRuntimes: this.settings.maxHydratedSessions,
      onBackgroundCompletion: (summary, outcome) => {
        if (!this.settings.notifyBackgroundSessionCompletion) return;
        showBackgroundSessionNotice(summary, outcome, (sessionId) => {
          void this.revealSession(sessionId);
        });
      },
      onStoreConflict: (error) => {
        new Notice(
          `A conversation changed on disk while editing it (${error.sessionId}). Your local changes were preserved under conflicts/; reload the conversation before sending again.`,
          10000,
        );
      },
    });

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Chatting with AI", (evt) => {
      if (evt.type === "contextmenu" || evt.button === 2) {
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => void this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New conversation").setIcon("plus").onClick(() => void this.newConversation())
        );
        menu.addItem((item) =>
          item.setTitle("Browse conversations").setIcon("list").onClick(() => void this.browseConversations())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => void this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => void this.shareTranscript())
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
      callback: () => void this.shareTranscript(),
    });

    this.addCommand({
      id: "new-conversation",
      name: "New conversation",
      callback: () => void this.newConversation(),
    });

    this.addCommand({
      id: "browse-conversations",
      name: "Browse conversations",
      callback: () => void this.browseConversations(),
    });

    this.addCommand({
      id: "switch-conversation",
      name: "Switch conversation",
      callback: () => void this.browseConversations(),
    });

    this.addCommand({
      id: "open-conversation-new-pane",
      name: "Open current conversation in new pane",
      checkCallback: (checking) => {
        if (Platform.isMobile) return false;
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.openCurrentInNewPane();
        return true;
      },
    });

    this.addCommand({
      id: "rename-conversation",
      name: "Rename conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.renameCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "pin-unpin-conversation",
      name: "Pin/unpin conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.pinToggleCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "archive-conversation",
      name: "Archive conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.archiveCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "show-archived-conversations",
      name: "Show archived conversations",
      callback: async () => {
        await this.openChat();
        this.getChatView()?.openBrowser("archived");
      },
    });

    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.forkCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "stop-conversation",
      name: "Stop current conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        view?.stopCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "delete-conversation",
      name: "Delete conversation",
      checkCallback: (checking) => {
        const view = this.getChatView();
        if (checking) return !!view?.currentSessionId;
        void view?.deleteCurrent();
        return true;
      },
    });

    this.addCommand({
      id: "rebuild-conversation-index",
      name: "Rebuild conversation index (recovery/advanced)",
      callback: async () => {
        await this.sessionStore.rebuildCatalogsFromBodies();
        new Notice("Conversation index rebuilt.");
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

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

    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        void this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

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
  }

  async onunload(): Promise<void> {
    // Running work cannot survive Obsidian process death; shutdown()
    // stops/flushes cleanly. Recovery markers (SessionRecoveryMarker) catch
    // the unclean-death case (crash / force-quit) on next load.
    await this.sessionManager?.shutdown();
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

  private async newConversation(): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    await this.getChatView()?.createAndSwitchToNewSession();
  }

  private async browseConversations(): Promise<void> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return;
    }
    await this.activateView();
    await this.getChatView()?.openBrowser();
  }

  /** Reveal (or open) the chat view and switch it to the given session. Used by background-completion notices. */
  private async revealSession(sessionId: string): Promise<void> {
    await this.activateView();
    const view = this.getChatView();
    if (view) await view.revealAndSwitchTo(sessionId);
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

  // ─── Session Workspaces plumbing ────────────────────────────────────

  /**
   * Builds the effective ChatSettings for a single session's agent adapter.
   * Provider/model/profile/effort are session-owned (SessionPreferences);
   * everything else (API key, custom instructions, iteration cap, web
   * search toggle) comes from current global settings. The API key is
   * looked up fresh per provider from SecretStorage — it is never read from
   * or written into session JSON (invariant #6).
   */
  private settingsForSession(session: PersistedSession): ChatSettings {
    const provider = session.preferences.provider;
    return {
      ...this.settings,
      provider,
      apiKey: provider === this.settings.provider ? this.settings.apiKey : this.loadApiKey(provider),
      model: session.preferences.model,
      activeProfileId: session.preferences.profileId ?? null,
      reasoningEffort: session.preferences.effortOverride ?? this.settings.reasoningEffort,
    };
  }

  private resolveMaxConcurrentSessions(): number {
    const configured = this.settings.maxConcurrentSessions;
    if (Platform.isMobile) return Math.min(configured, 2) || 2;
    return configured;
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
  if (typeof value.maxConcurrentSessions === "number") {
    settings.maxConcurrentSessions = clamp(value.maxConcurrentSessions, 1, 6);
  }
  if (typeof value.maxHydratedSessions === "number") {
    settings.maxHydratedSessions = clamp(value.maxHydratedSessions, 2, 24);
  }
  if (typeof value.notifyBackgroundSessionCompletion === "boolean") {
    settings.notifyBackgroundSessionCompletion = value.notifyBackgroundSessionCompletion;
  }
  if (typeof value.sessionManagerPinnedOnWideViews === "boolean") {
    settings.sessionManagerPinnedOnWideViews = value.sessionManagerPinnedOnWideViews;
  }
  return settings;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
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
