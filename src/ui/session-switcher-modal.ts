import { App, Menu, Notice, SuggestModal } from "obsidian";
import type { ConversationMeta } from "../sessions/metadata/types";
import type { SessionManager } from "../sessions/runtime/manager";

/**
 * Native Obsidian "Switch conversation…" picker backed by the Session
 * Workspaces v4.1 SessionManager's paginated Recent/Pinned/Archive query
 * (`.chatting/session-index/{manifest,hot,shards/*}`). Deliberately uses
 * Obsidian's built-in SuggestModal fuzzy list (works identically on desktop
 * and mobile) instead of porting the kit's bespoke SessionBrowser.svelte —
 * see the branch-11 completion report for that scope decision.
 */
export class SessionSwitcherModal extends SuggestModal<ConversationMeta> {
  /** Populated alongside each getSuggestions() call so renderSuggestion can show a background-activity dot. */
  private unread: ReadonlyMap<string, boolean> = new Map();

  constructor(
    app: App,
    private readonly manager: SessionManager,
    private readonly sessionScope: "active" | "pinned" | "archived",
    private readonly onChoose: (sessionId: string) => void,
    /**
     * One-shot snapshot of the opening ChatView's pane-layout mode
     * ("compact" | "regular" | "wide" | undefined), passed in because this
     * Modal mounts outside `contentEl`'s subtree and can't inherit the
     * `data-ochatting-pane-layout` attribute via CSS descendant selectors.
     * Applied to the modal root so styles.css can key off it (e.g. denser
     * suggestion rows / narrower padding in compact mode).
     */
    private readonly paneLayoutMode?: string,
  ) {
    super(app);
    this.setPlaceholder(
      sessionScope === "archived" ? "Search archived conversations…" : "Switch conversation…",
    );
  }

  onOpen(): void {
    super.onOpen();
    if (this.paneLayoutMode) {
      this.modalEl.dataset.ochattingPaneLayout = this.paneLayoutMode;
    }
  }

  async getSuggestions(query: string): Promise<ConversationMeta[]> {
    const result = await this.manager.query({
      scope: this.sessionScope,
      search: query.trim() || undefined,
      limit: 60,
    });
    this.unread = await this.manager.getUnreadMap(result.items.map((item) => item.id));
    return result.items;
  }

  renderSuggestion(item: ConversationMeta, el: HTMLElement): void {
    const phase = this.manager.getRuntimePhase(item.id);
    el.addClass("ochatting-session-suggestion");

    // Row layout: text block + an always-visible (not hover-only — this
    // plugin is mobile-first, so a hover affordance would be unreachable on
    // touch) "more actions" icon button. See the class-level comment on
    // `openRowMenu` for why this needs its own pointerdown/click guards.
    const row = el.createDiv({ cls: "ochatting-session-suggestion-row" });
    const textBlock = row.createDiv({ cls: "ochatting-session-suggestion-text" });

    const title = textBlock.createDiv({ cls: "ochatting-session-suggestion-title" });
    if (this.unread.get(item.id)) title.createSpan({ text: "● ", cls: "ochatting-session-suggestion-unread" });
    title.appendText(item.title || "New chat");
    if (item.isPinned) title.createSpan({ text: " 📌", cls: "ochatting-session-suggestion-pin" });
    if (phase !== "idle") title.createSpan({ text: ` [${phase}]`, cls: "ochatting-session-suggestion-status" });
    if (item.titleGenerationStatus === "pending") {
      title.createSpan({ text: " (generating title…)", cls: "ochatting-session-suggestion-status" });
    } else if (item.titleGenerationStatus === "failed") {
      title.createSpan({ text: " ⚠︎", cls: "ochatting-session-suggestion-title-warning", title: "Title generation failed" });
    }
    if (item.preview) {
      textBlock.createDiv({ cls: "ochatting-session-suggestion-preview", text: item.preview });
    }

    const moreButton = row.createEl("button", {
      cls: "ochatting-session-suggestion-more clickable-icon",
      attr: { "aria-label": "More actions", type: "button" },
    });
    moreButton.setText("⋯");
    // Prevent the click from also bubbling into SuggestModal's own
    // item-click handler (which would switch to this conversation instead
    // of opening the menu). Guard both pointerdown and click since
    // SuggestModal's chooser may bind on either depending on platform.
    moreButton.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    moreButton.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.openRowMenu(item, evt);
    });
  }

  onChooseSuggestion(item: ConversationMeta): void {
    this.onChoose(item.id);
  }

  /**
   * Per-row "more actions" menu (Rename / Regenerate title / Pin / Archive /
   * Fork / Delete) — an always-tappable icon button rather than a
   * hover-revealed affordance, since Browse/Switch is used on mobile where
   * hover doesn't exist. Reuses the exact same `SessionManager` methods the
   * command-palette commands in main.ts already call, so behavior never
   * diverges between the two entry points.
   */
  private openRowMenu(item: ConversationMeta, evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() => {
          const title = window.prompt("New conversation title:", item.title);
          if (title && title.trim()) {
            void this.manager.rename(item.id, title.trim()).then(() => this.refresh());
          }
        })
    );

    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Regenerate title")
        .setIcon("refresh-cw")
        .onClick(() => {
          void this.manager.regenerateTitle(item.id)
            .then(() => this.refresh())
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error));
            });
        })
    );

    menu.addItem((menuItem) =>
      menuItem
        .setTitle(item.isPinned ? "Unpin" : "Pin")
        .setIcon("pin")
        .onClick(() => {
          void this.manager.setPinned(item.id, !item.isPinned).then(() => this.refresh());
        })
    );

    menu.addItem((menuItem) =>
      menuItem
        .setTitle(item.isArchived ? "Unarchive" : "Archive")
        .setIcon("archive")
        .onClick(() => {
          const action = item.isArchived ? this.manager.unarchive(item.id) : this.manager.archive(item.id);
          void action
            .then(() => this.refresh())
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error));
            });
        })
    );

    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Fork")
        .setIcon("git-fork")
        .onClick(() => {
          void this.manager.fork(item.id).then((snapshot) => {
            this.close();
            this.onChoose(snapshot.metadata.id);
          });
        })
    );

    menu.addSeparator();

    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => {
          if (!window.confirm(`Delete "${item.title || "New chat"}"? This cannot be undone.`)) return;
          void this.manager.delete(item.id)
            .then(() => this.refresh())
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error));
            });
        })
    );

    menu.showAtMouseEvent(evt);
  }

  /**
   * Forces SuggestModal to re-run `getSuggestions()`/`renderSuggestion()`
   * against the current query — there's no public "refresh" API, so this
   * replays the same input event the built-in text field debounces on its
   * own typing.
   */
  private refresh(): void {
    this.inputEl.dispatchEvent(new Event("input"));
  }
}
