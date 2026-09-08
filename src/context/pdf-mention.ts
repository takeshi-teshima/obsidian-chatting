import { App, FuzzySuggestModal, TFile } from "obsidian";
import type { ContextRef } from "./refs";
import { ContextRefService } from "./ref-service";

export interface PdfMentionParseResult {
  /** User-visible request with the mention token removed. */
  text: string;
  /** Resolved PDF if the mention included an explicit target. */
  ref: ContextRef | null;
  /** True when a bare @pdf requested the picker. */
  needsPicker: boolean;
  /** Parsing/resolution problem safe to show to the user. */
  error?: string;
}

/**
 * Recognizes one leading/scoped @pdf token anywhere in the user input:
 *   @pdf [[Papers/a.pdf]] summarize the method
 *   compare this @pdf "Papers/a.pdf" with my note
 *   @pdf summarize this        -> picker required
 *
 * A single explicit PDF context per turn keeps UX and tool scoping predictable.
 */
export function parsePdfMention(app: App, input: string): PdfMentionParseResult {
  const service = new ContextRefService(app);
  const explicit = input.match(/@pdf\s+(\[\[[^\]]+\]\]|"[^"]+"|'[^']+'|[^\s]+\.pdf)/i);
  if (explicit) {
    const rawTarget = explicit[1];
    const ref = service.resolvePath(rawTarget, "pdf");
    if (!ref) {
      return {
        text: input.replace(explicit[0], "").trim(),
        ref: null,
        needsPicker: false,
        error: `Could not resolve PDF reference: ${rawTarget}`,
      };
    }
    return { text: input.replace(explicit[0], "").trim(), ref, needsPicker: false };
  }
  const bare = /(^|\s)@pdf(?=\s|$)/i.exec(input);
  if (bare) {
    const start = bare.index + bare[1].length;
    const text = (input.slice(0, start) + input.slice(start + 4)).replace(/\s{2,}/g, " ").trim();
    return { text, ref: null, needsPicker: true };
  }
  return { text: input, ref: null, needsPicker: false };
}

export function buildPdfScopedContext(ref: ContextRef): string {
  if (ref.kind !== "pdf") throw new Error("buildPdfScopedContext requires a PDF ContextRef");
  return [
    `[Scoped PDF context: ${ref.path}]`,
    `The user explicitly attached this vault PDF for the current turn.`,
    `Keep the PDF local. Use pdf_info/pdf_search/pdf_read with path "${ref.path}".`,
    `For long PDFs, search first and read only relevant pages. Do not upload or inline the entire PDF.`,
  ].join("\n");
}

export function choosePdf(app: App): Promise<ContextRef | null> {
  return new Promise((resolve) => {
    const modal = new PdfPickerModal(app, resolve);
    modal.open();
  });
}

class PdfPickerModal extends FuzzySuggestModal<TFile> {
  private finished = false;
  constructor(app: App, private readonly resolveResult: (ref: ContextRef | null) => void) { super(app); }
  getItems(): TFile[] { return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf"); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void {
    this.finished = true;
    this.resolveResult(new ContextRefService(this.app).fromFile(file, "pdf"));
  }
  onClose(): void {
    super.onClose();
    if (!this.finished) this.resolveResult(null);
  }
}
