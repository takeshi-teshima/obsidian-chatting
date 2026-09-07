import { App, SuggestModal } from "obsidian";
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
  ) {
    super(app);
    this.setPlaceholder(
      sessionScope === "archived" ? "Search archived conversations…" : "Switch conversation…",
    );
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
    const title = el.createDiv({ cls: "ochatting-session-suggestion-title" });
    if (this.unread.get(item.id)) title.createSpan({ text: "● ", cls: "ochatting-session-suggestion-unread" });
    title.appendText(item.title || "New chat");
    if (item.isPinned) title.createSpan({ text: " 📌", cls: "ochatting-session-suggestion-pin" });
    if (phase !== "idle") title.createSpan({ text: ` [${phase}]`, cls: "ochatting-session-suggestion-status" });
    if (item.preview) {
      el.createDiv({ cls: "ochatting-session-suggestion-preview", text: item.preview });
    }
  }

  onChooseSuggestion(item: ConversationMeta): void {
    this.onChoose(item.id);
  }
}
