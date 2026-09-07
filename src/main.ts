import {
  Plugin,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
} from "obsidian";
import type { ChatSettings, Provider, SelectionScope } from "./types";
import { DEFAULT_SETTINGS, CHATGPT_OAUTH_DEFAULT_MODEL } from "./types";
import { ChatSettingTab, getModelOptions } from "./settings";
import { migrateLegacyModelSelection, readModelSelectionSeed } from "./model-selection/settings-migration";
import { ModelSelectionSeedCoordinator } from "./model-selection/seed-coordinator";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { SessionSwitcherModal } from "./ui/session-switcher-modal";
import { AgentLoop } from "./agent/loop";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { ObsidianSessionStorageAdapter } from "./sessions/obsidian-storage-adapter";
import { ObsidianLegacyReadAdapter } from "./sessions/obsidian-legacy-read-adapter";
import { SessionMetadataStore } from "./sessions/metadata/store";
import { ChattingHistoryStore } from "./sessions/history/store";
import { SessionIndexStore } from "./sessions/index/store";
import { SessionLocalStateStore } from "./sessions/local/store";
import { SessionWorkspaceStore, type CreateSessionInput } from "./sessions/store";
import { runMigration } from "./sessions/migration/run-migration";
import { loadActiveSessionId, saveActiveSessionId } from "./sessions/runtime/active-session";
import { SessionManager, type SessionAgentFactory } from "./sessions/runtime/manager";
import { AgentLoopSessionAdapter } from "./sessions/runtime/agent-loop-adapter";
import type { SessionAgentAdapter } from "./sessions/runtime/runtime";
import { getChattingProviderState, type SessionMetadata } from "./sessions/metadata/types";

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

  /** Session Workspaces v4.1 canonical storage (`.chatting/...` at the vault root). */
  private sessionAdapter!: ObsidianSessionStorageAdapter;
  private sessionStore!: SessionWorkspaceStore;
  /**
   * Owns every hydrated per-session runtime (one AgentLoop + one
   * ProviderConversationState each). There is intentionally no
   * plugin-global `agent`/`chatHistory`/`activeSessionId` any more — each
   * ObsidianChatView leaf binds to a session id independently, and a
   * session's runtime lives exactly as long as it is hydrated, regardless
   * of which (if any) leaf is currently looking at it. See
   * sessions/runtime/manager.ts and CHAT_VIEW_INTEGRATION.md.
   */
  sessionManager!: SessionManager;

  /**
   * App-wide latest-wins ordering for explicit composer picker choices that
   * seed `lastSelectedChatModel` (Session Workspaces v4.3, branch 14). A
   * slow async model-metadata fetch completing late must not roll back a
   * newer explicit choice; see model-selection/seed-coordinator.ts.
   */
  modelSelectionSeedCoordinator!: ModelSelectionSeedCoordinator;

  async onload(): Promise<void> {
    await this.migrateLegacyPluginData();
    await this.loadSettings();

    this.modelSelectionSeedCoordinator = new ModelSelectionSeedCoordinator({
      mutate: async (update) => {
        const changed = update(this.settings as unknown as Record<string, unknown>);
        if (changed) await this.saveSettings();
      },
    });

    // Wire ChatGPT OAuth before constructing the agent: the OAuth API client
    // looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);

    this.sessionAdapter = new ObsidianSessionStorageAdapter(this.app);
    this.sessionStore = new SessionWorkspaceStore(
      new SessionMetadataStore(this.sessionAdapter),
      new ChattingHistoryStore(this.sessionAdapter),
      new SessionLocalStateStore(this.sessionAdapter),
      new SessionIndexStore(this.sessionAdapter),
    );
    this.sessionManager = new SessionManager({
      store: this.sessionStore,
      agentFactory: this.buildAgentFactory(),
      getDefaultSessionSeed: () => this.defaultSessionSeed(),
      getTurnSelectionFallback: (metadata) => {
        const state = getChattingProviderState(metadata);
        const provider = isProvider(state.upstreamProvider) ? state.upstreamProvider : this.settings.provider;
        return {
          provider,
          model: metadata.selectedModel || this.settings.model,
          reasoningEffort: isReasoningEffort(state.reasoningEffort) ? state.reasoningEffort : this.settings.reasoningEffort,
        };
      },
      maxConcurrentRuns: 3,
      maxHydratedRuntimes: 8,
      onBackgroundCompletion: (sessionId, outcome) => {
        if (outcome === "error") new Notice(`A background conversation hit an error (${sessionId.slice(0, 12)}…).`);
      },
    });

    // Runs v3/branch-11/legacy migration into `.chatting/` canonical storage
    // on first run (idempotent after), then builds/loads the scalable
    // hot/sharded navigation index.
    await this.initializeSessionStorage();

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
      callback: () => {
        const view = this.getChatView();
        if (!view) { new Notice("No active conversation."); return; }
        void view.reloadFromDiskCommand();
      },
    });

    // ─── Session Workspaces v4.1: multi-session commands ─────────────────
    // Kept as command-palette fallbacks alongside the per-view header UI, per
    // MERGE_INSTRUCTIONS.md ("Required commands/actions").

    this.addCommand({
      id: "new-conversation",
      name: "New conversation",
      callback: () => void this.newConversation(),
    });

    this.addCommand({
      id: "switch-conversation",
      name: "Switch conversation…",
      callback: () => this.openSwitcherForActiveView(),
    });

    this.addCommand({
      id: "rename-conversation",
      name: "Rename conversation",
      callback: () => void this.renameActiveConversation(),
    });

    this.addCommand({
      id: "pin-conversation",
      name: "Pin/unpin conversation",
      callback: () => void this.togglePinActiveConversation(),
    });

    this.addCommand({
      id: "archive-conversation",
      name: "Archive/unarchive conversation",
      callback: () => void this.toggleArchiveActiveConversation(),
    });

    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation",
      callback: () => void this.forkActiveConversation(),
    });

    this.addCommand({
      id: "delete-conversation",
      name: "Delete conversation",
      callback: () => void this.deleteActiveConversation(),
    });

    this.addCommand({
      id: "stop-conversation",
      name: "Stop current conversation",
      callback: () => void this.stopActiveConversation(),
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
    // Only plugin unload owns global shutdown: abort every active runtime
    // and best-effort flush each to disk. Closing/switching an individual
    // ChatView leaf must never do this (see sessions/runtime/manager.ts).
    void this.sessionManager?.shutdown();
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
      // Seed the very first leaf with the last-bound session (if any) so a
      // fresh Obsidian window doesn't always default to "most recently
      // active" when the user had a different session open when they quit.
      const remembered = await loadActiveSessionId(this.sessionAdapter);
      await leaf.setViewState({
        type: VIEW_TYPE_CHAT,
        active: true,
        state: remembered ? { sessionId: remembered } : undefined,
      });
      await workspace.revealLeaf(leaf);
    }
  }

  /** Persists the last-bound session id as a convenience default for the next freshly created leaf (e.g. after an Obsidian restart). */
  async rememberActiveSession(sessionId: string): Promise<void> {
    await saveActiveSessionId(this.sessionAdapter, sessionId);
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

  // ─── Session Workspaces v4.1 multi-session runtime ─────────────────────
  //
  // Canonical storage is `.chatting/session-metadata/<id>.meta.json` +
  // `.chatting/sessions/<id>.jsonl` (Claudian-shaped metadata + Chatting-
  // native UnifiedMessage JSONL transcript). `SessionManager` (constructed in
  // onload) owns every hydrated per-session runtime; persistence-per-turn is
  // now the runtime's job (sessions/runtime/runtime.ts checkpoints after
  // every assistant/tool-result/error and on run completion), not something
  // the plugin drives directly. See src/sessions/ and MIGRATION_HANDOFF.md /
  // MERGE_INSTRUCTIONS.md / CHAT_VIEW_INTEGRATION.md for the full contract.

  /**
   * Boot-time restore: runs the (idempotent, non-destructive) v3/branch-11/
   * legacy-chat-state migration into `.chatting/` canonical storage, then
   * initializes (or, on first run after this migration, rebuilds) the
   * scalable hot/sharded navigation index the SessionManager's query() reads.
   */
  private async initializeSessionStorage(): Promise<void> {
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

    await this.sessionStore.initialize();

    // If no session exists at all yet (fresh vault, migration produced
    // nothing), seed exactly one blank session so the first view has
    // something to bind to.
    const stats = await this.sessionStore.getStats();
    if (stats.activeCount === 0 && stats.archivedCount === 0) {
      await this.sessionManager.createSession();
    }
  }

  /** Builds a fresh per-session AgentLoop + SessionAgentAdapter. Never shares one AgentLoop instance across sessions. */
  private buildAgentFactory(): SessionAgentFactory {
    return {
      create: (metadata: SessionMetadata): SessionAgentAdapter => {
        const state = getChattingProviderState(metadata);
        const provider = isProvider(state.upstreamProvider) ? state.upstreamProvider : this.settings.provider;
        const sessionSettings: ChatSettings = {
          ...this.settings,
          provider,
          apiKey: this.loadApiKey(provider),
          model: metadata.selectedModel || this.settings.model,
          activeProfileId: state.profileId !== undefined ? state.profileId : this.settings.activeProfileId,
          reasoningEffort: isReasoningEffort(state.reasoningEffort) ? state.reasoningEffort : this.settings.reasoningEffort,
          enableWebSearch: state.webSearch ?? this.settings.enableWebSearch,
        };
        const agent = new AgentLoop(this.app, sessionSettings);
        return new AgentLoopSessionAdapter(agent, {
          resetProviderContinuation: () => agent.resetContinuationState(),
          // Applies the admitted TurnExecutionConfig to this AgentLoop's
          // session-local settings clone immediately before AgentLoop.run()
          // starts the tool loop for this turn. Never touches plugin.settings
          // or any other session's AgentLoop. See turn-execution/turn-settings.ts.
          applyTurnExecution: (execution) => {
            agent.updateSettings({
              provider: execution.provider,
              model: execution.model,
              apiKey: this.loadApiKey(execution.provider),
              ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
            });
          },
          // OpenAI: clears previousResponseId only when provider/model actually
          // changed since this session's last turn, forcing a full history
          // replay on the first request of a new model rather than chaining
          // off a response id that belongs to a different model.
          prepareProviderContinuation: (provider, model) => {
            agent.prepareProviderConversation(provider, model);
          },
          applySessionMetadata: (next) => {
            const nextState = getChattingProviderState(next);
            agent.updateSettings({
              model: next.selectedModel || sessionSettings.model,
              activeProfileId: nextState.profileId !== undefined ? nextState.profileId : sessionSettings.activeProfileId,
              reasoningEffort: isReasoningEffort(nextState.reasoningEffort) ? nextState.reasoningEffort : sessionSettings.reasoningEffort,
            });
          },
        });
      },
    };
  }

  private defaultSessionSeed(): CreateSessionInput {
    const { provider, model } = this.resolveNewSessionModelSeed();
    return {
      title: "New chat",
      selectedModel: model,
      upstreamProvider: provider,
      profileId: this.settings.activeProfileId,
      reasoningEffort: this.settings.reasoningEffort,
      webSearch: this.settings.enableWebSearch,
    };
  }

  /**
   * New-conversation model resolution (SETTINGS_MIGRATION.md): prefer the
   * durable `lastSelectedChatModel` seed if its provider is still enabled;
   * otherwise fall back to the first enabled provider's default model;
   * otherwise fall back to whatever legacy `settings.provider`/`model` hold
   * (keeps a completely fresh install functional). This is a SEED only —
   * once a session exists, its own `SessionMetadata.selectedModel` /
   * `providerState.upstreamProvider` are authoritative and never re-resolve
   * through here.
   */
  private resolveNewSessionModelSeed(): { provider: Provider; model: string } {
    const enabled = this.getEnabledProviders();
    const seed = readModelSelectionSeed(this.settings);
    if (seed && enabled.includes(seed.providerId)) {
      return { provider: seed.providerId, model: seed.model };
    }
    const fallbackProvider = enabled[0] ?? this.settings.provider;
    return { provider: fallbackProvider, model: this.defaultModelFor(fallbackProvider) };
  }

  /** Providers with usable credentials right now: an API key (anthropic/openai) or a live ChatGPT OAuth connection. */
  getEnabledProviders(): Provider[] {
    const enabled: Provider[] = [];
    if (this.loadApiKey("anthropic")) enabled.push("anthropic");
    if (this.loadApiKey("openai")) enabled.push("openai");
    if (this.chatgptOAuth?.getCredential()) enabled.push("chatgpt-oauth");
    return enabled;
  }

  getProviderLabel(provider: Provider): string {
    if (provider === "anthropic") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    return "ChatGPT OAuth";
  }

  private defaultModelFor(provider: Provider): string {
    if (provider === this.settings.provider && this.settings.model) return this.settings.model;
    if (provider === "chatgpt-oauth") return CHATGPT_OAUTH_DEFAULT_MODEL;
    return getModelOptions(provider)[0]?.value ?? this.settings.model;
  }

  /** Renders a session's transcript to markdown without requiring its runtime to be hydrated. */
  async exportTranscriptFor(sessionId: string): Promise<string> {
    const workspace = await this.sessionStore.load(sessionId);
    if (!workspace) return "";
    const parts: string[] = [
      `# Chatting with AI Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Title:** ${workspace.metadata.title}`,
      ``,
      `## Conversation`,
      ``,
    ];
    for (const msg of workspace.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`, ``, msg.content, ``);
        continue;
      }
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`, ``, block.text, ``);
        } else if (block.type === "tool_use") {
          parts.push(`### Tool Call: \`${block.name}\``, ``, "```json", JSON.stringify(block.input, null, 2), "```", ``);
        } else if (block.type === "tool_result") {
          parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`, ``, "```", block.content || "(empty)", "```", ``);
        }
      }
    }
    return parts.join("\n");
  }

  private async newConversation(): Promise<void> {
    await this.activateView();
    const view = this.getChatView();
    if (!view) return;
    const snapshot = await this.sessionManager.createSession();
    await view.switchToSession(snapshot.metadata.id);
  }

  private openSwitcherForActiveView(): void {
    const view = this.getChatView();
    if (!view) { new Notice("No active conversation."); return; }
    new SessionSwitcherModal(this.app, this.sessionManager, "active", (id) => {
      void view.switchToSession(id);
    }).open();
  }

  private async renameActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    const title = window.prompt("New conversation title:");
    if (title && title.trim()) await this.sessionManager.rename(id, title.trim());
  }

  private async togglePinActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    const meta = await this.sessionManager.query({ scope: "active", limit: 1 });
    const current = meta.items.find((m) => m.id === id);
    await this.sessionManager.setPinned(id, !(current?.isPinned ?? false));
  }

  private async toggleArchiveActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    try {
      await this.sessionManager.archive(id);
      new Notice("Conversation archived.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async forkActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    const snapshot = await this.sessionManager.fork(id);
    await view!.switchToSession(snapshot.metadata.id);
  }

  private async deleteActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    try {
      await this.sessionManager.delete(id);
      new Notice("Conversation deleted.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async stopActiveConversation(): Promise<void> {
    const view = this.getChatView();
    const id = view?.boundSession();
    if (!id) { new Notice("No active conversation."); return; }
    await this.sessionManager.stop(id);
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

    // One-way seed migration (Session Workspaces v4.3, branch 14): copy the
    // legacy provider+model pair into `lastSelectedChatModel` ONLY when no
    // seed exists yet. Never overwrites an existing seed, never touches any
    // existing session's own `SessionMetadata.selectedModel`. Legacy
    // `settings.provider`/`settings.model` are left in place for rollback
    // safety but are never read as execution authority again after this.
    const migration = migrateLegacyModelSelection(this.settings);
    if (migration.migrated) {
      this.settings = migration.settings;
      this.saveData({ ...this.settings, apiKey: "" }).catch(() => {});
    }
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);

    // NOTE: this used to push `settings.model`'s display name into the chat
    // header on every settings save. Since Session Workspaces v4.3 (branch
    // 14), the header reflects each session's own next-turn selection
    // (ChatView.refreshTurnSelector(), driven by SessionMetadata.selectedModel
    // / providerState.upstreamProvider), not plugin-global settings — pushing
    // settings.model here would incorrectly clobber it on an unrelated
    // settings change (e.g. toggling web search).
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
