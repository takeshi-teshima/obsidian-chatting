import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import type { SessionMetadata } from "./types";

export class SessionPickerModal extends FuzzySuggestModal<SessionMetadata> {
  constructor(
    app: App,
    private readonly sessions: readonly SessionMetadata[],
    private readonly onPick: (session: SessionMetadata) => void,
  ) {
    super(app);
    this.setPlaceholder("Switch conversation...");
  }

  getItems(): SessionMetadata[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getItemText(item: SessionMetadata): string {
    return `${item.title} — ${formatDate(item.updatedAt)}`;
  }

  onChooseItem(item: SessionMetadata): void {
    this.onPick(item);
  }
}

export function promptSessionTitle(
  app: App,
  initialValue: string,
): Promise<string | null> {
  return new Promise((resolve) => new SessionTitleModal(app, initialValue, resolve).open());
}

export function confirmDeleteSession(
  app: App,
  title: string,
): Promise<boolean> {
  return new Promise((resolve) => new ConfirmDeleteSessionModal(app, title, resolve).open());
}

class SessionTitleModal extends Modal {
  private value: string;
  private finished = false;

  constructor(
    app: App,
    initialValue: string,
    private readonly resolveResult: (value: string | null) => void,
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.contentEl.empty();
    new Setting(this.contentEl).setName("Rename conversation").setHeading();
    const setting = new Setting(this.contentEl)
      .setName("Title")
      .addText((text) => {
        text.setValue(this.value).onChange((value) => { this.value = value; });
        window.setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 0);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.finish(this.value);
          }
        });
      });
    setting.addButton((button) => button.setButtonText("Save").setCta().onClick(() => this.finish(this.value)));
  }

  onClose(): void {
    if (!this.finished) this.resolveResult(null);
  }

  private finish(value: string): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveResult(value.trim());
    this.close();
  }
}

class ConfirmDeleteSessionModal extends Modal {
  private finished = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly resolveResult: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    new Setting(this.contentEl).setName("Delete conversation?").setHeading();
    this.contentEl.createEl("p", {
      text: `Delete “${this.title}”? This removes the session file from the plugin data directory.`,
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((button) => button.setButtonText("Delete").setWarning().onClick(() => this.finish(true)));
  }

  onClose(): void {
    if (!this.finished) this.resolveResult(false);
  }

  private finish(value: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveResult(value);
    this.close();
  }
}

function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "unknown time";
  }
}
