import { Notice } from "obsidian";
import type { SessionRunOutcome, SessionSummary } from "./types";

/** In-app completion notice for work that finished in a non-visible session. */
export function showBackgroundSessionNotice(
  summary: SessionSummary,
  outcome: SessionRunOutcome,
  openSession: (sessionId: string) => void,
): void {
  if (outcome === "stopped") return;
  const fragment = document.createDocumentFragment();
  const text = fragment.createEl("span", {
    cls: "cw-session-completion-notice",
    text: outcome === "completed"
      ? `Finished: ${summary.title}`
      : `Session needs attention: ${summary.title}`,
  });
  text.setAttribute("role", "button");
  text.setAttribute("tabindex", "0");
  const open = () => openSession(summary.id);
  text.addEventListener("click", open);
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") open();
  });
  new Notice(fragment, 7000);
}
