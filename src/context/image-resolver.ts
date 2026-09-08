import { App, TFile, normalizePath } from "obsidian";
import type { ContextRef } from "./refs";
import { ContextRefService } from "./ref-service";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export type SupportedImageMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

const SUPPORTED_MIME = new Set<SupportedImageMime>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export interface ResolvedImageInput {
  ref: ContextRef;
  mime: SupportedImageMime;
  /** Raw base64 with no `data:` prefix. */
  base64: string;
  /** Provider-friendly inline URL. */
  dataUrl: string;
  byteLength: number;
}

export interface ImageResolver {
  resolve(ref: ContextRef): Promise<ResolvedImageInput>;
}

/**
 * Loads image bytes only at the provider request boundary.
 * The returned base64/data URL must never be stored in session/chat state.
 */
export class VaultImageResolver implements ImageResolver {
  private readonly refs: ContextRefService;

  constructor(private readonly app: App) {
    this.refs = new ContextRefService(app);
  }

  async resolve(ref: ContextRef): Promise<ResolvedImageInput> {
    if (ref.kind !== "image") {
      throw new Error(`Image resolver received non-image context: ${ref.path}`);
    }

    if (!isSupportedImageMime(ref.mime)) {
      throw new Error(
        `Unsupported image type for AI vision: ${ref.mime || "unknown"}. ` +
        `Use JPEG, PNG, WebP, or GIF.`,
      );
    }

    if (ref.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image is too large for mobile-safe AI attachment handling: ${ref.path} ` +
        `(${formatBytes(ref.size)}; limit ${formatBytes(MAX_IMAGE_BYTES)}).`,
      );
    }

    const inspection = this.refs.inspect(ref);
    if (!inspection.exists || !inspection.current) {
      throw new Error(`Attached image no longer exists in the vault: ${ref.path}`);
    }
    if (inspection.stale) {
      throw new Error(
        `Attached image changed since it was selected: ${ref.path}. ` +
        `Remove it and attach the current version again.`,
      );
    }

    const file = this.app.vault.getFileByPath(normalizePath(ref.path));
    if (!(file instanceof TFile)) {
      throw new Error(`Attached image is not a vault file: ${ref.path}`);
    }

    const data = await this.app.vault.readBinary(file);
    if (data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image is too large after reading: ${ref.path} ` +
        `(${formatBytes(data.byteLength)}; limit ${formatBytes(MAX_IMAGE_BYTES)}).`,
      );
    }

    const base64 = arrayBufferToBase64(data);
    return {
      ref,
      mime: ref.mime,
      base64,
      dataUrl: `data:${ref.mime};base64,${base64}`,
      byteLength: data.byteLength,
    };
  }
}

export function isSupportedImageMime(value: string): value is SupportedImageMime {
  return SUPPORTED_MIME.has(value as SupportedImageMime);
}

export function assertImageRefEnvelope(refs: readonly ContextRef[]): void {
  const images = refs.filter((ref) => ref.kind === "image");
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(
      `Too many images attached (${images.length}). ` +
      `The mobile-safe limit is ${MAX_IMAGES_PER_MESSAGE} per message.`,
    );
  }

  let total = 0;
  for (const ref of images) {
    if (!isSupportedImageMime(ref.mime)) {
      throw new Error(
        `Unsupported image type for ${ref.path}: ${ref.mime || "unknown"}. ` +
        `Use JPEG, PNG, WebP, or GIF.`,
      );
    }
    if (ref.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image is too large: ${ref.path} (${formatBytes(ref.size)}; ` +
        `limit ${formatBytes(MAX_IMAGE_BYTES)}).`,
      );
    }
    total += ref.size;
  }

  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(
      `Attached images total ${formatBytes(total)}; ` +
      `the mobile-safe per-message limit is ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}.`,
    );
  }
}

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const parts: string[] = [];
  const chunkSize = 0x8000;

  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, bytes.length);
    let chunk = "";
    for (let i = start; i < end; i++) {
      chunk += String.fromCharCode(bytes[i]);
    }
    parts.push(chunk);
  }

  return btoa(parts.join(""));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
