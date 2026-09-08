import { ItemView, WorkspaceLeaf, Notice, Menu, Platform, type App, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope } from "../types";
import type { ContextRef } from "../context/refs";
import { ImageIngestService } from "../context/image-ingest";
import { getModelDisplayName } from "../settings";
import type {
  SessionQueryResult,
  SessionRunPhase,
  SessionRuntimeEvent,
  SessionRuntimeSnapshot,
} from "../session/types";

export const VIEW_TYPE_CHAT = "ochatting-view";

interface SessionTabItem {
  id: string;
  title: string;
  phase: SessionRunPhase;
  unread: boolean;
}

interface SessionBrowserProps {
  result: SessionQueryResult;
  currentSessionId: string | null;
  scope: "active" | "pinned" | "archived";
  search: string;
  sort: "activity" | "created";
  runtimePhases: ReadonlyMap<string, SessionRunPhase>;
  activeCount: number;
  pinnedCount: number;
  archivedCount: number;
  onScope: (scope: "active" | "pinned" | "archived") => void;
  onSearch: (value: string) => void;
  onSort: (sort: "activity" | "created") => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onLoadMore: () => void;
  onActions: (id: string, event: MouseEvent) => void;
}

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
  onOpenSessionBrowser: () => void;
  onNewSession: () => void;
  onSessionMenu: (event: MouseEvent) => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
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
  setSessionHeader(title: string, phase: SessionRunPhase, hasUnread: boolean): void;
  setTabs(tabs: SessionTabItem[], currentSessionId: string | null): void;
  showSessionBrowser(props: SessionBrowserProps): void;
  updateSessionBrowser(patch: Partial<SessionBrowserProps>): void;
  hideSessionBrowser(): void;
  isSessionBrowserOpen(): boolean;
  getDraft(): { text: string; contextRefs: ContextRef[] };
  setDraft(text: string, refs: ContextRef[]): void;
}

let viewIdCounter = 0;
const MAX_TABS = 10;

/**
 * Chat view for Chatting with AI. Desktop: right sidebar. Mobile: right
 * sidebar (slides in from edge).
 *
 * Session Workspaces: this view no longer owns any conversation state
 * itself. Each ObsidianChatView instance has a stable in-memory `viewId`
 * that binds to exactly one session via `plugin.sessionManager`. The view
 * is a projection of that session's SessionRuntime — it renders history
 * from the runtime snapshot and subsequent SessionRuntimeEvents, and never
 * mutates persisted chat state directly. Closing/switching this view never
 * aborts the bound session's run (invariant #3 of the Session Workspaces
 * merge — see MERGE_INSTRUCTIONS.md).
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ChatContainerApi | undefined;
  private readonly imageIngest: ImageIngestService;
  private readonly viewId: string;

  private boundSessionId: string | null = null;
  private pendingRequestedSessionId: string | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private readonly toolCallIds = new Map<string, number>();
  private tabs: SessionTabItem[] = [];

  private browserScope: "active" | "pinned" | "archived" = "active";
  private browserSearch = "";
  private browserSort: "activity" | "created" = "activity";
  private browserResult: SessionQueryResult | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.imageIngest = new ImageIngestService(this.app);
    this.viewId = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `view_${Date.now()}_${viewIdCounter++}`;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    // Distinct from upstream "Chat" tab so users running both plugins
    // side-by-side can tell the workspace tabs apart.
    return "Chatting with AI";
  }

  getIcon(): string {
    return "message-circle";
  }

  /** Persist which session this pane is bound to across Obsidian workspace layout saves. */
  getState(): Record<string, unknown> {
    return { ...super.getState(), sessionId: this.boundSessionId };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isRecord(state) && typeof state.sessionId === "string") {
      this.pendingRequestedSessionId = state.sessionId;
    }
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("ochatting-view-container");

    this.chatContainer = mount<ChatContainerProps, ChatContainerApi>(
      ChatContainer as unknown as Component<ChatContainerProps, ChatContainerApi>,
      {
        target: container,
        props: {
          app: this.app,
          component: this,
          provider: this.plugin.settings.provider,
          model: getModelDisplayName(this.plugin.settings.provider, this.plugin.settings.model),
          onSend: (text: string, selection: SelectionScope | null, contextRefs: ContextRef[]) => {
            void this.handleUserMessage(text, selection, contextRefs);
          },
          onClear: () => this.handleClear(),
          onReload: () => void this.handleReload(),
          onStop: () => this.handleStop(),
          onAttachFiles: (files: File[]) => this.handleAttachFiles(files),
          onOpenSessionBrowser: () => void this.openBrowser(),
          onNewSession: () => void this.createAndSwitchToNewSession(),
          onSessionMenu: (event: MouseEvent) => void this.showSessionMenu(event),
          onSelectTab: (id: string) => void this.switchToSession(id),
          onCloseTab: (id: string) => this.closeTab(id),
        },
      },
    );

    const requested = this.pendingRequestedSessionId;
    this.pendingRequestedSessionId = null;
    const snapshot = await this.plugin.sessionManager.bindView(this.viewId, requested);
    this.boundSessionId = snapshot.session.id;
    this.pushTab(snapshot.session.id, snapshot.session.title);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.plugin.sessionManager.setViewVisible(this.viewId, leaf === this.leaf);
      }),
    );
    this.plugin.sessionManager.setViewVisible(this.viewId, this.app.workspace.activeLeaf === this.leaf);

    // subscribeRuntime() delivers an immediate "snapshot" event on
    // subscribe, which is what actually renders history — see
    // handleRuntimeEvent(). No separate render call here to avoid a
    // double-render (and thus double-append) on open.
    await this.subscribeRuntime();
    this.chatContainer.focus();
  }

  async onClose(): Promise<void> {
    await this.saveDraft();
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.plugin.sessionManager.unbindView(this.viewId);
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  /** Export the full transcript for debugging. Uses the bound session's own history. */
  async getTranscript(): Promise<string> {
    if (!this.boundSessionId) return "";
    const session = await this.plugin.sessionStore.load(this.boundSessionId);
    if (!session) return "";
    const parts: string[] = [
      `# Chatting with AI Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${session.preferences.provider}`,
      `**Model:** ${session.preferences.model}`,
      ``,
      `## Conversation`,
      ``,
    ];
    for (const entry of session.chatHistory) {
      if (entry.type === "user") parts.push(`### User\n\n${entry.text ?? ""}\n`);
      else if (entry.type === "assistant") parts.push(`### Assistant\n\n${entry.text ?? ""}\n`);
      else if (entry.type === "tool-result") parts.push(`### Tool: ${entry.toolName}\n\n\`\`\`\n${entry.toolResult?.result ?? ""}\n\`\`\`\n`);
      else if (entry.type === "error") parts.push(`### Error\n\n${entry.text ?? ""}\n`);
    }
    return parts.join("\n");
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    void this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  /**
   * Copies device/pasted image files into the vault (respecting the user's
   * configured attachment folder) and attaches the resulting ContextRefs to
   * the composer.
   */
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

  /** Set the selection scope and show the pill */
  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  /** Focus the input */
  focus(): void {
    this.chatContainer?.focus();
  }

  /** Update the model display name in the header */
  updateModel(name: string): void {
    this.chatContainer?.setModel(name);
  }

  /** Clear conversation: for Session Workspaces this deletes the bound
   * session's runtime message history by starting a fresh session in its
   * place. This never destroys other sessions. */
  clearConversation(): void {
    this.handleClear();
  }

  /** Reveal this pane and switch it to the given session. Used by main.ts commands and background-completion notices. */
  async revealAndSwitchTo(sessionId: string): Promise<void> {
    await this.plugin.app.workspace.revealLeaf(this.leaf);
    await this.switchToSession(sessionId);
  }

  get currentSessionId(): string | null {
    return this.boundSessionId;
  }

  // ─── Public command entry points (used by main.ts command palette) ─────

  async renameCurrent(): Promise<void> {
    if (this.boundSessionId) await this.renameSession(this.boundSessionId);
  }

  async pinToggleCurrent(): Promise<void> {
    if (!this.boundSessionId) return;
    const summary = await this.plugin.sessionStore.getSummary(this.boundSessionId);
    if (!summary) return;
    await this.plugin.sessionManager.setPinned(this.boundSessionId, !summary.isPinned);
  }

  async archiveCurrent(): Promise<void> {
    if (this.boundSessionId) await this.archiveSession(this.boundSessionId);
  }

  async forkCurrent(): Promise<void> {
    if (this.boundSessionId) await this.forkSession(this.boundSessionId);
  }

  stopCurrent(): void {
    if (this.boundSessionId) void this.plugin.sessionManager.stop(this.boundSessionId);
  }

  async deleteCurrent(): Promise<void> {
    if (this.boundSessionId) await this.deleteSession(this.boundSessionId);
  }

  async openCurrentInNewPane(): Promise<void> {
    if (this.boundSessionId) await this.openInNewPane(this.boundSessionId);
  }

  /** Command-palette entry point for the same recovery path as the Reload button. */
  async reloadCurrentFromDisk(): Promise<void> {
    await this.handleReload();
  }

  // ─── Session binding / runtime projection ──────────────────────────────

  private async subscribeRuntime(): Promise<void> {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = await this.plugin.sessionManager.subscribeView(
      this.viewId,
      (event) => this.handleRuntimeEvent(event),
    );
  }

  private handleRuntimeEvent(event: SessionRuntimeEvent): void {
    const chat = this.chatContainer;
    if (!chat) return;
    switch (event.type) {
      case "snapshot":
        this.applySnapshot(event.snapshot);
        break;
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
        const id = this.toolCallIds.get(`latest-${event.name}`);
        if (id !== undefined) chat.updateToolResult(id, event.name, event.result);
        break;
      }
      case "assistant":
        chat.hideThinking();
        chat.addAssistantMessage(event.text);
        break;
      case "ask-user":
        chat.hideThinking();
        void this.presentPendingQuestion(event.question);
        break;
      case "run-state": {
        const busy = event.phase === "running" || event.phase === "queued" || event.phase === "stopping";
        chat.setInputEnabled(!busy);
        break;
      }
      case "run-complete":
        chat.hideThinking();
        chat.setInputEnabled(true);
        break;
      case "error":
        chat.hideThinking();
        chat.addError(event.message);
        break;
    }
  }

  /** Render a full runtime snapshot (used on bind/switch and whenever the runtime re-broadcasts one). */
  private applySnapshot(snapshot: SessionRuntimeSnapshot): void {
    const chat = this.chatContainer;
    if (!chat) return;
    chat.clearMessages();
    this.toolCallIds.clear();
    for (const entry of snapshot.session.chatHistory) {
      switch (entry.type) {
        case "user":
          chat.addUserMessage(entry.text ?? "");
          break;
        case "assistant":
          chat.addAssistantMessage(entry.text ?? "");
          break;
        case "tool-result":
          if (entry.toolName) {
            const id = chat.addToolCall(entry.toolName, entry.toolInput ?? {});
            if (entry.toolResult) chat.updateToolResult(id, entry.toolName, entry.toolResult);
          }
          break;
        case "error":
          chat.addError(entry.text ?? "");
          break;
      }
    }
    chat.setDraft(snapshot.session.draft.text, snapshot.session.draft.contextRefs);
    chat.setSessionHeader(snapshot.session.title, snapshot.phase, snapshot.session.hasUnreadActivity);
    const busy = snapshot.phase === "running" || snapshot.phase === "queued" || snapshot.phase === "stopping";
    chat.setInputEnabled(!busy);
    if (snapshot.pendingQuestion) void this.presentPendingQuestion(snapshot.pendingQuestion);
    this.renderTabs();
  }

  /**
   * Renders a pending ask_user question from either a live "ask-user" event
   * or a restored snapshot (e.g. switching back into a session that is
   * still `waiting_user`). Answering always routes through
   * SessionManager.answer() — this never issues a second provider request.
   */
  private async presentPendingQuestion(question: string): Promise<void> {
    const chat = this.chatContainer;
    if (!chat) return;
    chat.setInputEnabled(true);
    const answer = await chat.showAskUser(question);
    const id = this.boundSessionId;
    if (id) await this.plugin.sessionManager.answer(id, answer);
  }

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    contextRefs: ContextRef[] = [],
  ): Promise<void> {
    const id = this.boundSessionId;
    if (!id) return;
    const chat = this.chatContainer;
    if (!chat) return;

    // Optimistic render: SessionRuntime.run() pushes the user message
    // synchronously but does not emit a dedicated event for it, so the
    // initiating view renders it directly. Any other view later bound to
    // this session sees it via the next bind/switch snapshot.
    chat.addUserMessage(text);
    chat.setInputEnabled(false);

    try {
      await this.plugin.sessionManager.run(id, { text, contextRefs, selection });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
      chat.setInputEnabled(true);
    }
  }

  private handleStop(): void {
    const id = this.boundSessionId;
    if (!id) return;
    void this.plugin.sessionManager.stop(id);
  }

  private handleClear(): void {
    // "Clear" now means: start a fresh session in this pane. The old
    // session (and its history) is left completely intact on disk — it
    // simply stops being bound to this view. This matches the invariant
    // that a view can never destroy session data merely by navigating.
    void (async () => {
      await this.saveDraft();
      this.unsubscribeRuntime?.();
      this.unsubscribeRuntime = null;
      const created = await this.plugin.sessionManager.createSession();
      this.boundSessionId = created.id;
      await this.plugin.sessionManager.switchView(this.viewId, created.id);
      this.pushTab(created.id, created.title);
      await this.subscribeRuntime();
      new Notice("Started a new conversation.");
    })();
  }

  /**
   * Emergency recovery entry point: force the bound session's runtime to
   * re-read its persisted body from disk (see
   * SessionManager.reloadFromDisk / SessionRuntime.reloadFromDisk),
   * discarding in-memory state in favor of the file. This is the workflow
   * that lets a human hand-edit an oversized session body on disk (to trim
   * a runaway tool result) and have the already-running session pick it up
   * without an Obsidian restart.
   *
   * Refuses (via a Notice, not a silent no-op) if the session is currently
   * running a turn.
   */
  private async handleReload(): Promise<void> {
    const id = this.boundSessionId;
    if (!id) return;
    try {
      await this.plugin.sessionManager.reloadFromDisk(id);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }
    // reloadFromDisk() already broadcasts a fresh "snapshot" event to this
    // view's existing subscription; resubscribing here is redundant with
    // that but kept for parity with other navigation paths (switchToSession
    // etc.) that always resubscribe after a session-state change.
    await this.subscribeRuntime();
    new Notice("Chat reloaded from disk.");
  }

  private async saveDraft(): Promise<void> {
    const chat = this.chatContainer;
    if (!chat) return;
    try {
      const draft = chat.getDraft();
      await this.plugin.sessionManager.setDraftForView(this.viewId, draft.text, draft.contextRefs);
    } catch {
      // Best-effort; never block navigation on draft persistence.
    }
  }

  async switchToSession(id: string): Promise<void> {
    if (id === this.boundSessionId) {
      this.chatContainer?.hideSessionBrowser();
      return;
    }
    await this.saveDraft();
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    let snapshot: SessionRuntimeSnapshot;
    try {
      snapshot = await this.plugin.sessionManager.switchView(this.viewId, id);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      await this.subscribeRuntime();
      return;
    }
    this.boundSessionId = snapshot.session.id;
    this.pushTab(snapshot.session.id, snapshot.session.title);
    await this.subscribeRuntime();
    this.chatContainer?.hideSessionBrowser();
    this.chatContainer?.focus();
  }

  async createAndSwitchToNewSession(): Promise<void> {
    const created = await this.plugin.sessionManager.createSession();
    await this.switchToSession(created.id);
  }

  private closeTab(id: string): void {
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.renderTabs();
    // Closing a tab is a UI shortcut only — never aborts or deletes the
    // runtime. If it was the pane's current session, fall back to the most
    // recently used remaining tab (or a fresh session if none remain).
    if (id === this.boundSessionId) {
      const fallback = this.tabs[0]?.id;
      if (fallback) void this.switchToSession(fallback);
      else void this.createAndSwitchToNewSession();
    }
  }

  private pushTab(id: string, title: string): void {
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.tabs.unshift({ id, title, phase: "idle", unread: false });
    if (this.tabs.length > MAX_TABS) this.tabs.length = MAX_TABS;
    this.renderTabs();
  }

  private renderTabs(): void {
    // Wide desktop only; ChatContainer/SessionTabStrip also hide via CSS
    // media query as a second safety net for narrow desktop windows.
    const tabs = Platform.isMobile ? [] : this.tabs;
    this.chatContainer?.setTabs(tabs, this.boundSessionId);
  }

  // ─── Session browser (overlay) ──────────────────────────────────────────

  async openBrowser(scope: "active" | "pinned" | "archived" = "active"): Promise<void> {
    this.browserScope = scope;
    this.browserSearch = "";
    this.browserSort = "activity";
    await this.refreshBrowser();
  }

  private async refreshBrowser(): Promise<void> {
    const chat = this.chatContainer;
    if (!chat) return;
    const result = await this.plugin.sessionManager.query({
      scope: this.browserScope,
      search: this.browserSearch,
      sort: this.browserSort,
      limit: 60,
    });
    this.browserResult = result;
    const stats = await this.plugin.sessionManager.getStats();
    const runtimePhases = this.plugin.sessionManager.getHydratedPhases();
    const props: SessionBrowserProps = {
      result,
      currentSessionId: this.boundSessionId,
      scope: this.browserScope,
      search: this.browserSearch,
      sort: this.browserSort,
      runtimePhases,
      activeCount: stats.activeCount,
      pinnedCount: stats.pinnedCount,
      archivedCount: stats.archivedCount,
      onScope: (scope) => { this.browserScope = scope; void this.refreshBrowser(); },
      onSearch: (value) => { this.browserSearch = value; void this.refreshBrowser(); },
      onSort: (sort) => { this.browserSort = sort; void this.refreshBrowser(); },
      onOpen: (id) => void this.switchToSession(id),
      onNew: () => void this.createAndSwitchToNewSession(),
      onLoadMore: () => void this.loadMoreBrowser(),
      onActions: (id, event) => void this.showRowActions(id, event),
    };
    if (chat.isSessionBrowserOpen()) chat.updateSessionBrowser(props);
    else chat.showSessionBrowser(props);
  }

  private async loadMoreBrowser(): Promise<void> {
    if (!this.browserResult || this.browserResult.nextOffset === null) return;
    const next = await this.plugin.sessionManager.query({
      scope: this.browserScope,
      search: this.browserSearch,
      sort: this.browserSort,
      limit: 60,
      offset: this.browserResult.nextOffset,
    });
    this.browserResult = {
      items: [...this.browserResult.items, ...next.items],
      total: next.total,
      offset: this.browserResult.offset,
      nextOffset: next.nextOffset,
    };
    this.chatContainer?.updateSessionBrowser({ result: this.browserResult });
  }

  private showSessionMenu(event: MouseEvent): void {
    const id = this.boundSessionId;
    if (!id) return;
    void this.showRowActions(id, event);
  }

  private async showRowActions(id: string, event: MouseEvent): Promise<void> {
    const summary = await this.plugin.sessionStore.getSummary(id);
    if (!summary) return;
    const phase = this.plugin.sessionManager.getHydratedPhases().get(id) ?? "idle";
    const busy = phase !== "idle";
    const menu = new Menu();

    if (summary.isArchived) {
      menu.addItem((item) => item.setTitle("Unarchive and open").setIcon("archive-restore").onClick(() => void this.unarchiveAndOpen(id)));
      menu.addItem((item) => item.setTitle("Fork to active").setIcon("git-fork").onClick(() => void this.forkSession(id)));
      menu.addItem((item) => item.setTitle("Delete").setIcon("trash").onClick(() => void this.deleteSession(id)));
    } else if (busy) {
      menu.addItem((item) => item.setTitle("Open").setIcon("message-circle").onClick(() => void this.switchToSession(id)));
      menu.addItem((item) => item.setTitle("Stop").setIcon("square").onClick(() => void this.plugin.sessionManager.stop(id)));
      menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(() => void this.renameSession(id)));
      menu.addItem((item) => item.setTitle(summary.isPinned ? "Unpin" : "Pin").setIcon("pin").onClick(() => void this.plugin.sessionManager.setPinned(id, !summary.isPinned).then(() => void this.refreshBrowser())));
    } else {
      menu.addItem((item) => item.setTitle("Open").setIcon("message-circle").onClick(() => void this.switchToSession(id)));
      if (!Platform.isMobile) {
        menu.addItem((item) => item.setTitle("Open in new pane").setIcon("layout-panel-left").onClick(() => void this.openInNewPane(id)));
      }
      menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(() => void this.renameSession(id)));
      menu.addItem((item) => item.setTitle(summary.isPinned ? "Unpin" : "Pin").setIcon("pin").onClick(() => void this.plugin.sessionManager.setPinned(id, !summary.isPinned).then(() => void this.refreshBrowser())));
      menu.addItem((item) => item.setTitle("Archive").setIcon("archive").onClick(() => void this.archiveSession(id)));
      menu.addItem((item) => item.setTitle("Fork").setIcon("git-fork").onClick(() => void this.forkSession(id)));
      menu.addItem((item) => item.setTitle("Delete").setIcon("trash").onClick(() => void this.deleteSession(id)));
    }
    menu.showAtMouseEvent(event);
  }

  private async unarchiveAndOpen(id: string): Promise<void> {
    await this.plugin.sessionManager.unarchive(id);
    await this.switchToSession(id);
    void this.refreshBrowser();
  }

  private async renameSession(id: string): Promise<void> {
    const summary = await this.plugin.sessionStore.getSummary(id);
    const next = window.prompt("Rename conversation", summary?.title ?? "");
    if (next === null) return;
    await this.plugin.sessionManager.rename(id, next);
    void this.refreshBrowser();
  }

  private async archiveSession(id: string): Promise<void> {
    try {
      await this.plugin.sessionManager.archive(id);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }
    if (id === this.boundSessionId) {
      // archive() already rebinds any view bound to it; refresh our local pointer.
      const rebound = this.plugin.sessionManager.getBoundSessionId(this.viewId);
      if (rebound && rebound !== id) await this.switchToSession(rebound);
    }
    void this.refreshBrowser();
  }

  private async forkSession(id: string): Promise<void> {
    const fork = await this.plugin.sessionManager.fork(id);
    await this.switchToSession(fork.id);
    void this.refreshBrowser();
  }

  private async deleteSession(id: string): Promise<void> {
    const confirmed = window.confirm("Delete this conversation? This cannot be undone.");
    if (!confirmed) return;
    try {
      await this.plugin.sessionManager.delete(id);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (id === this.boundSessionId) {
      const rebound = this.plugin.sessionManager.getBoundSessionId(this.viewId);
      if (rebound) await this.switchToSession(rebound);
    }
    void this.refreshBrowser();
  }

  private async openInNewPane(id: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true, state: { sessionId: id } });
    await this.app.workspace.revealLeaf(leaf);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
