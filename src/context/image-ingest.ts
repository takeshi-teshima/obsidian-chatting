import { App, TFile } from "obsidian";
import type { ContextRef } from "./refs";
import { ContextRefService } from "./ref-service";
import {
  MAX_IMAGE_BYTES,
  isSupportedImageMime,
  type SupportedImageMime,
} from "./image-resolver";

export interface ImageImportResult {
  refs: ContextRef[];
  errors: string[];
}

/**
 * Copies browser-provided images into the vault, then returns ordinary
 * JSON-safe ContextRefs. No File/Blob/ArrayBuffer is retained after import.
 */
export class ImageIngestService {
  private readonly refs: ContextRefService;

  constructor(private readonly app: App) {
    this.refs = new ContextRefService(app);
  }

  async importFiles(files: readonly File[], sourcePath = ""): Promise<ImageImportResult> {
    const refs: ContextRef[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        refs.push(await this.importOne(file, sourcePath));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file.name || "Image"}: ${message}`);
      }
    }

    return { refs, errors };
  }

  /** Extract supported image files from a clipboard event without consuming text-only paste. */
  filesFromPaste(event: ClipboardEvent): File[] {
    const data = event.clipboardData;
    if (!data) return [];
    return Array.from(data.files).filter((file) => {
      const mime = normalizedMime(file);
      return mime !== null;
    });
  }

  private async importOne(file: File, sourcePath: string): Promise<ContextRef> {
    const mime = normalizedMime(file);
    if (!mime) {
      throw new Error(
        `Unsupported image format (${file.type || extensionOf(file.name) || "unknown"}). ` +
        `Use JPEG, PNG, WebP, or GIF. HEIC/HEIF is not sent without conversion.`,
      );
    }

    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image is ${(file.size / 1024 / 1024).toFixed(1)} MiB; ` +
        `the mobile-safe limit is ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MiB.`,
      );
    }

    const filename = safeFilename(file.name, mime);
    const targetPath = await this.app.fileManager.getAvailablePathForAttachment(
      filename,
      sourcePath || undefined,
    );

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("Image exceeded the size limit while reading it.");
    }

    const created = await this.app.vault.createBinary(targetPath, buffer);
    if (!(created instanceof TFile)) {
      throw new Error(`Obsidian did not create a file for ${filename}.`);
    }

    const ref = this.refs.fromFile(created, "image");
    if (!ref) {
      throw new Error(`Created attachment is not a supported image: ${created.path}`);
    }
    return ref;
  }
}

function normalizedMime(file: File): SupportedImageMime | null {
  if (isSupportedImageMime(file.type)) return file.type;

  const ext = extensionOf(file.name);
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

function safeFilename(original: string, mime: SupportedImageMime): string {
  const fallbackExt = extensionForMime(mime);
  const trimmed = original.trim().replace(/[\\/\0]/g, "-");
  if (!trimmed) return `Chat image ${timestampForFilename()}.${fallbackExt}`;
  if (extensionOf(trimmed)) return trimmed;
  return `${trimmed}.${fallbackExt}`;
}

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function extensionForMime(mime: SupportedImageMime): string {
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
  }
}

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
