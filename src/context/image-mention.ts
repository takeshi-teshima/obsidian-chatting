import { App, FuzzySuggestModal, TFile } from "obsidian";
import type { ContextRef } from "./refs";
import { ContextRefService } from "./ref-service";

export interface ImageMentionParseResult {
  /** User-visible request with the mention token removed. */
  text: string;
  /** Resolved image when the mention contains an explicit target. */
  ref: ContextRef | null;
  /** True for a bare @image that requests the vault-image picker. */
  needsPicker: boolean;
  error?: string;
}

const EXPLICIT_IMAGE = /@image\s+(\[\[[^\]]+\]\]|"[^"]+"|'[^']+'|[^\s]+\.(?:png|jpe?g|webp|gif))/i;

/** Parse one @image token without loading image bytes. */
export function parseImageMention(app: App, input: string): ImageMentionParseResult {
  const service = new ContextRefService(app);
  const explicit = input.match(EXPLICIT_IMAGE);
  if (explicit) {
    const rawTarget = explicit[1];
    const ref = service.resolvePath(rawTarget, "image");
    if (!ref) {
      return {
        text: removeSpan(input, explicit.index ?? 0, explicit[0].length),
        ref: null,
        needsPicker: false,
        error: `Could not resolve image reference: ${rawTarget}`,
      };
    }
    return {
      text: removeSpan(input, explicit.index ?? 0, explicit[0].length),
      ref,
      needsPicker: false,
    };
  }

  const bare = /(^|\s)@image(?=\s|$)/i.exec(input);
  if (bare) {
    const start = bare.index + bare[1].length;
    return {
      text: removeSpan(input, start, "@image".length),
      ref: null,
      needsPicker: true,
    };
  }

  return { text: input, ref: null, needsPicker: false };
}

export function buildImageScopedContext(ref: ContextRef): string {
  if (ref.kind !== "image") throw new Error("buildImageScopedContext requires an image ContextRef");
  return `[Attached vault image: ${ref.path}]`;
}

export function chooseImage(app: App): Promise<ContextRef | null> {
  return new Promise((resolve) => new ImagePickerModal(app, resolve).open());
}

class ImagePickerModal extends FuzzySuggestModal<TFile> {
  private finished = false;
  private readonly refs: ContextRefService;

  constructor(
    app: App,
    private readonly resolveResult: (ref: ContextRef | null) => void,
  ) {
    super(app);
    this.refs = new ContextRefService(app);
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => this.refs.fromFile(file, "image") !== null);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.finished = true;
    this.resolveResult(this.refs.fromFile(file, "image"));
  }

  onClose(): void {
    super.onClose();
    if (!this.finished) this.resolveResult(null);
  }
}

function removeSpan(input: string, start: number, length: number): string {
  return (input.slice(0, start) + input.slice(start + length))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
