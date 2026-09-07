import { ItemView, WorkspaceLeaf, Notice, Menu, Modal, Setting, type App, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope } from "../types";
import type { ContextRef } from "../context/refs";
import { ImageIngestService } from "../context/image-ingest";
import { getModelDisplayName } from "../settings";
import { deriveDisplayHistory } from "../sessions/display-history";
import type { SessionRuntimeEvent, SessionRuntimeSnapshot } from "../sessions/runtime/types";
import { SessionSwitcherModal } from "./session-switcher-modal";
import { observePaneLayout } from "./responsive/pane-layout";

export const VIEW_TYPE_CHAT = "ochatting-view";

interface ChatContainerProps {
  app: App;
  component: ObsidianChatView;
  provider: string;
  model: string;
  onSend: (text: string, selection: SelectionScope | null, contextRefs: ContextRef[]) => void;
  onClear: () => void;
  onReload: () => void;
  onStop: () => void;
  onAttachFiles: (files: File[]) => Promise<void>;
}

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string): void;
  addAssistantMessage(text: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string): void;
  showThinking(): void;
  hideThinking(): void;
  showAskUser(question: string): Promise<string>;
  setInputEnabled(enabled: boolean): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
  addContextRef(ref: ContextRef): void;
  removeContextRefById(id: string): void;
  getContextRefs(): ContextRef[];
}

interface ChatViewState {
  sessionId?: string;
}

/**
 * Chat view for Chatting with AI, bound to exactly one session id at a time
 * via the plugin-wide `SessionManager` (Session Workspaces v4.1-complete).
 *
 * Multiple leaves may exist concurrently, each independently bound to any
 * session; closing/switching a leaf never stops that session's runtime — only
 * `SessionManager.shutdown()` (plugin unload) does. See
 * CHAT_VIEW_INTEGRATION.md in the v4.1 kit for the integration contract this
 * follows.
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ChatContainerApi | undefined;
  private readonly imageIngest: ImageIngestService;

  /** Stable per-leaf identity for SessionManager view binding. Not persisted;
   * a reopened leaf gets a fresh viewId and rebinds via getState()/setState(). */
  private readonly viewId: string = crypto.randomUUID();
  private boundSessionId: string | null = null;
  private runtimeUnsubscribe: (() => void) | undefined;
  private toolCallIds = new Map<string, number>();
  private askUserActive = false;
  private lastPhase: SessionRuntimeSnapshot["phase"] = "idle";

  private sessionBarTitleEl: HTMLElement | undefined;

  /**
   * Live pane-width layout observer (Session Workspaces v4.1, branch 11:
   * see RESPONSIVE_SESSION_UI.md). Keys off the actual ChatView content
   * width via ResizeObserver — never `window.innerWidth`/`Platform.isMobile`
   * — so a narrow desktop sidebar behaves identically to a narrow mobile
   * pane. Sets `data-ochatting-pane-layout` + `--ochatting-pane-width` on
   * `this.contentEl` for CSS to key off (see styles.css). No in-view
   * consumer of the mode value exists yet beyond CSS and the one-shot read
   * below when opening SessionSwitcherModal (which mounts outside
   * `contentEl`'s subtree via Obsidian's own Modal machinery, so it can't
   * be reached by a descendant selector off this attribute and needs the
   * value passed in explicitly).
   */
  private stopPaneLayoutObserver: (() => void) | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.imageIngest = new ImageIngestService(this.app);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Chatting with AI";
  }

  getIcon(): string {
    return "message-circle";
  }

  // ─── Obsidian view-state (navigation only, never transcript/runtime) ────

  getState(): Record<string, unknown> {
    return { ...super.getState(), sessionId: this.boundSessionId };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const requested = isChatViewState(state) ? state.sessionId : undefined;
    if (requested && requested !== this.boundSessionId && this.chatContainer) {
      await this.bindToSession(requested);
    } else if (requested && !this.chatContainer) {
      // onOpen hasn't mounted yet; remember it for onOpen to pick up.
      this.pendingRestoreSessionId = requested;
    }
  }

  private pendingRestoreSessionId: string | undefined;

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("ochatting-view-container");
    this.stopPaneLayoutObserver = observePaneLayout(container, () => undefined);

    const sessionBar = container.createDiv({ cls: "ochatting-session-bar" });
    this.sessionBarTitleEl = sessionBar.createSpan({ cls: "ochatting-session-bar-title", text: "Loading…" });
    this.sessionBarTitleEl.onClickEvent(() => this.openSwitcher());
    const newBtn = sessionBar.createEl("button", { cls: "ochatting-session-bar-btn", text: "+", attr: { title: "New conversation" } });
    newBtn.onClickEvent(() => void this.createAndSwitchToNewSession());
    const menuBtn = sessionBar.createEl("button", { cls: "ochatting-session-bar-btn", text: "⋯", attr: { title: "Conversation actions" } });
    menuBtn.onClickEvent((evt) => this.openSessionMenu(evt));

    const mountTarget = container.createDiv({ cls: "ochatting-chat-mount" });

    this.chatContainer = mount<ChatContainerProps, ChatContainerApi>(
      ChatContainer as unknown as Component<ChatContainerProps, ChatContainerApi>,
      {
        target: mountTarget,
        props: {
          app: this.app,
          component: this,
          provider: this.plugin.settings.provider,
          model: getModelDisplayName(this.plugin.settings.provider, this.plugin.settings.model),
          onSend: (text: string, selection: SelectionScope | null, contextRefs: ContextRef[]) => {
            void this.handleUserMessage(text, selection, contextRefs);
          },
          onClear: () => void this.handleClear(),
          onReload: () => void this.handleReload(),
          onStop: () => void this.handleStop(),
          onAttachFiles: (files: File[]) => this.handleAttachFiles(files),
        },
      },
    );

    await this.bindToSession(this.pendingRestoreSessionId);
    this.pendingRestoreSessionId = undefined;
    this.chatContainer.focus();
  }

  async onClose(): Promise<void> {
    this.stopPaneLayoutObserver?.();
    this.stopPaneLayoutObserver = undefined;
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    if (this.boundSessionId) {
      this.plugin.sessionManager.unbindView(this.viewId);
    }
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  // ─── Session binding ─────────────────────────────────────────────────

  private async bindToSession(requestedSessionId?: string | null): Promise<void> {
    this.runtimeUnsubscribe?.();
    this.runtimeUnsubscribe = undefined;
    this.toolCallIds.clear();
    this.askUserActive = false;

    const manager = this.plugin.sessionManager;
    const snapshot = this.boundSessionId === null
      ? await manager.bindView(this.viewId, requestedSessionId ?? undefined)
      : await manager.switchView(this.viewId, requestedSessionId!);
    this.boundSessionId = snapshot.metadata.id;
    this.runtimeUnsubscribe = await manager.subscribeView(this.viewId, (event) => this.handleRuntimeEvent(event));
    this.updateSessionBarTitle(snapshot);
    void this.plugin.rememberActiveSession(this.boundSessionId);
  }

  /** Public: switch this leaf to a different (existing) session. */
  async switchToSession(sessionId: string): Promise<void> {
    if (sessionId === this.boundSessionId) return;
    // Persist the outgoing session's draft before leaving it.
    this.persistDraft();
    this.chatContainer?.clearMessages();
    await this.bindToSession(sessionId);
    // No explicit setViewState() call needed: Obsidian calls getState() (which
    // now reflects the new boundSessionId) whenever it serializes workspace
    // layout, so the binding survives restarts without us re-entering
    // setState() ourselves here.
  }

  private async createAndSwitchToNewSession(): Promise<void> {
    const snapshot = await this.plugin.sessionManager.createSession();
    await this.switchToSession(snapshot.metadata.id);
  }

  private openSwitcher(): void {
    new SessionSwitcherModal(this.app, this.plugin.sessionManager, "active", (id) => {
      void this.switchToSession(id);
    }, this.currentPaneLayoutMode()).open();
  }

  /** One-shot read of the live pane-layout dataset attribute (see
   * `stopPaneLayoutObserver` above); used only when opening a Modal, since
   * Modals mount outside `contentEl`'s subtree and can't pick this up via CSS
   * descendant selectors on their own. */
  private currentPaneLayoutMode(): string | undefined {
    return this.contentEl.dataset.ochattingPaneLayout;
  }

  private openSessionMenu(evt: MouseEvent): void {
    const id = this.boundSessionId;
    if (!id) return;
    const manager = this.plugin.sessionManager;
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("Rename conversation").setIcon("pencil").onClick(() => {
      new RenamePromptModal(this.app, (title) => void manager.rename(id, title)).open();
    }));
    menu.addItem((item) => item.setTitle("Pin conversation").setIcon("pin").onClick(() => void manager.setPinned(id, true)));
    menu.addItem((item) => item.setTitle("Unpin conversation").setIcon("pin-off").onClick(() => void manager.setPinned(id, false)));
    menu.addItem((item) => item.setTitle("Fork conversation").setIcon("git-branch").onClick(() => void this.forkCurrentSession()));
    menu.addItem((item) => item.setTitle("Archive conversation").setIcon("archive").onClick(() => void this.archiveCurrentSession()));
    menu.addItem((item) => item.setTitle("Browse archived…").setIcon("folder").onClick(() => {
      new SessionSwitcherModal(this.app, manager, "archived", (archivedId) => {
        void manager.unarchive(archivedId).then(() => this.switchToSession(archivedId));
      }, this.currentPaneLayoutMode()).open();
    }));
    menu.addItem((item) => item.setTitle("Delete conversation").setIcon("trash").onClick(() => void this.deleteCurrentSession()));
    menu.showAtMouseEvent(evt);
  }

  private async forkCurrentSession(): Promise<void> {
    if (!this.boundSessionId) return;
    try {
      const snapshot = await this.plugin.sessionManager.fork(this.boundSessionId);
      await this.switchToSession(snapshot.metadata.id);
      new Notice("Forked conversation.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async archiveCurrentSession(): Promise<void> {
    if (!this.boundSessionId) return;
    try {
      await this.plugin.sessionManager.archive(this.boundSessionId);
      new Notice("Conversation archived.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async deleteCurrentSession(): Promise<void> {
    if (!this.boundSessionId) return;
    try {
      await this.plugin.sessionManager.delete(this.boundSessionId);
      new Notice("Conversation deleted.");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private updateSessionBarTitle(snapshot: SessionRuntimeSnapshot): void {
    if (this.sessionBarTitleEl) {
      const pin = snapshot.metadata.isPinned ? "📌 " : "";
      this.sessionBarTitleEl.setText(`${pin}${snapshot.metadata.title || "New chat"}`);
    }
  }

  /**
   * Persists per-session draft state to the `.chatting/session-state/`
   * sidecar before switching away. NOTE: `ChatContainerApi` does not
   * currently expose the composer's raw text (only ContextRefs and
   * selection scope), so only attached ContextRefs round-trip through a
   * session switch in this pass; the typed-but-unsent text is not yet
   * restored. Extending `ChatContainer.svelte` with a `getDraftText()`
   * accessor would close this gap without any storage changes.
   */
  private persistDraft(): void {
    if (!this.boundSessionId) return;
    const refs = this.chatContainer?.getContextRefs() ?? [];
    void this.plugin.sessionManager.setDraftForView(this.viewId, "", refs);
  }

  // ─── Runtime event -> UI ─────────────────────────────────────────────

  private handleRuntimeEvent(event: SessionRuntimeEvent): void {
    const chat = this.chatContainer;
    if (!chat) return;
    switch (event.type) {
      case "snapshot": {
        this.renderSnapshot(event.snapshot);
        break;
      }
      case "thinking":
        chat.showThinking();
        break;
      case "tool-call":
        chat.hideThinking();
        if (event.name === "ask_user") break;
        this.toolCallIds.set(`latest-${event.name}`, chat.addToolCall(event.name, event.input));
        break;
      case "tool-result": {
        if (event.name === "ask_user") break;
        const msgId = this.toolCallIds.get(`latest-${event.name}`);
        if (msgId !== undefined) chat.updateToolResult(msgId, event.name, event.result);
        break;
      }
      case "assistant":
        chat.hideThinking();
        chat.addAssistantMessage(event.text);
        break;
      case "ask-user":
        this.presentAskUser(event.question);
        break;
      case "run-state":
        this.lastPhase = event.phase;
        chat.setInputEnabled(event.phase === "idle" || event.phase === "waiting_user");
        if (event.phase === "idle") this.toolCallIds.clear();
        break;
      case "run-complete":
        chat.hideThinking();
        chat.setInputEnabled(true);
        chat.focus();
        break;
      case "error":
        chat.hideThinking();
        chat.addError(event.message);
        break;
    }
  }

  private renderSnapshot(snapshot: SessionRuntimeSnapshot): void {
    const chat = this.chatContainer;
    if (!chat) return;
    this.updateSessionBarTitle(snapshot);
    chat.clearMessages();
    for (const entry of deriveDisplayHistory(snapshot.messages)) {
      switch (entry.type) {
        case "user":
          chat.addUserMessage(entry.text!);
          break;
        case "assistant":
          chat.addAssistantMessage(entry.text!);
          break;
        case "tool-result":
          if (entry.toolName && entry.toolResult) {
            const id = chat.addToolCall(entry.toolName, entry.toolInput || {});
            chat.updateToolResult(id, entry.toolName, entry.toolResult);
          }
          break;
        case "error":
          chat.addError(entry.text!);
          break;
      }
    }
    this.lastPhase = snapshot.phase;
    chat.setInputEnabled(snapshot.phase === "idle" || snapshot.phase === "waiting_user");
    if (snapshot.phase === "waiting_user" && snapshot.pendingQuestion) {
      this.presentAskUser(snapshot.pendingQuestion);
    } else {
      this.askUserActive = false;
    }
  }

  private presentAskUser(question: string): void {
    if (this.askUserActive) return;
    this.askUserActive = true;
    const chat = this.chatContainer;
    if (!chat) return;
    chat.hideThinking();
    chat.setInputEnabled(true);
    void chat.showAskUser(question).then((answer) => {
      this.askUserActive = false;
      const id = this.boundSessionId;
      if (id) void this.plugin.sessionManager.answer(id, answer);
    });
  }

  // ─── User actions ────────────────────────────────────────────────────

  /** Export the full transcript for debugging (current session only). */
  async getTranscript(): Promise<string> {
    if (!this.boundSessionId) return "";
    return this.plugin.exportTranscriptFor(this.boundSessionId);
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    void this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  private async handleAttachFiles(files: File[]): Promise<void> {
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    const result = await this.imageIngest.importFiles(files, sourcePath);

    for (const error of result.errors) {
      new Notice(error);
    }
    for (const ref of result.refs) {
      try {
        this.chatContainer?.addContextRef(ref);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    }
  }

  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  focus(): void {
    this.chatContainer?.focus();
  }

  updateModel(name: string): void {
    this.chatContainer?.setModel(name);
  }

  clearConversation(): void {
    void this.handleClear();
  }

  /** Whether THIS view's bound session is currently running/queued/stopping a turn. */
  isRunning(): boolean {
    return this.lastPhase !== "idle" && this.lastPhase !== "waiting_user";
  }

  boundSession(): string | null {
    return this.boundSessionId;
  }

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    contextRefs: ContextRef[] = [],
  ): Promise<void> {
    const sessionId = this.boundSessionId;
    if (!sessionId) return;
    if (this.plugin.sessionManager.getRuntimePhase(sessionId) !== "idle") {
      new Notice("Please wait for the current response to complete.");
      return;
    }

    const chat = this.chatContainer!;
    this.toolCallIds.clear();
    chat.addUserMessage(text);
    chat.setInputEnabled(false);

    try {
      await this.plugin.sessionManager.runForView(this.viewId, { text, selection, contextRefs });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
    } finally {
      chat.setInputEnabled(true);
      chat.focus();
    }
  }

  private async handleStop(): Promise<void> {
    if (!this.boundSessionId) return;
    await this.plugin.sessionManager.stop(this.boundSessionId);
    const chat = this.chatContainer;
    if (chat) {
      chat.hideThinking();
      chat.setInputEnabled(true);
      chat.focus();
    }
  }

  /**
   * "Clear" now starts a fresh conversation and switches this leaf to it,
   * rather than destructively wiping the current session's persisted
   * history in place. This is a deliberate behavior change under the
   * multi-session model: sessions are addressable/shareable objects now, so
   * silently truncating one out from under any other leaf that might be
   * bound to it (or its browser/index entry) is no longer safe. The old
   * conversation remains available via "Switch conversation…".
   */
  private async handleClear(): Promise<void> {
    await this.createAndSwitchToNewSession();
  }

  /**
   * Reload the bound session's `.chatting/sessions/<id>.jsonl` fresh from
   * disk (recovery for hand-edited transcripts), scoped to this one session.
   * Refuses while this session is mid-turn; other sessions are unaffected
   * either way since SessionManager.reloadFromDisk only touches the runtime
   * for `sessionId`.
   */
  /** Command-palette entry point for the reload-from-disk recovery path. */
  async reloadFromDiskCommand(): Promise<void> {
    await this.handleReload();
  }

  private async handleReload(): Promise<void> {
    const sessionId = this.boundSessionId;
    if (!sessionId) return;
    if (this.plugin.sessionManager.getRuntimePhase(sessionId) !== "idle") {
      new Notice("Can't reload from disk while a response is in progress. Stop it first.");
      return;
    }
    try {
      this.runtimeUnsubscribe?.();
      const snapshot = await this.plugin.sessionManager.reloadFromDisk(sessionId);
      this.runtimeUnsubscribe = await this.plugin.sessionManager.subscribeView(this.viewId, (event) => this.handleRuntimeEvent(event));
      this.renderSnapshot(snapshot);
      this.chatContainer?.setInputEnabled(true);
      this.chatContainer?.focus();
      new Notice("Conversation reloaded from disk.");
    } catch (error) {
      new Notice(`Reload from disk failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isChatViewState(value: unknown): value is ChatViewState {
  return !!value && typeof value === "object" && (
    (value as ChatViewState).sessionId === undefined || typeof (value as ChatViewState).sessionId === "string"
  );
}

class RenamePromptModal extends Modal {
  private value = "";
  constructor(app: App, private readonly onSubmit: (title: string) => void) {
    super(app);
  }
  onOpen(): void {
    this.setTitle("Rename conversation");
    new Setting(this.contentEl).addText((text) => {
      text.setPlaceholder("Conversation title").onChange((v) => (this.value = v));
      text.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText("Rename").setCta().onClick(() => this.submit())
    );
  }
  private submit(): void {
    if (this.value.trim()) this.onSubmit(this.value.trim());
    this.close();
  }
}
