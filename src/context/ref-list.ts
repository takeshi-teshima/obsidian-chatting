import type { ContextRef } from "./refs";
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_IMAGE_BYTES,
  assertImageRefEnvelope,
} from "./image-resolver";

/** Merge context refs by id while preserving display/insertion order. */
export function mergeContextRefs(
  current: readonly ContextRef[],
  additions: readonly ContextRef[],
): ContextRef[] {
  const result: ContextRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...current, ...additions]) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    result.push(ref);
  }
  assertImageRefEnvelope(result);
  return result;
}

export function removeContextRef(refs: readonly ContextRef[], id: string): ContextRef[] {
  return refs.filter((ref) => ref.id !== id);
}

export function imageRefCount(refs: readonly ContextRef[]): number {
  return refs.filter((ref) => ref.kind === "image").length;
}

export function contextRefLabel(ref: ContextRef): string {
  return `${ref.kind === "pdf" ? "PDF" : "Image"}: ${ref.name}`;
}

export function imageLimitSummary(): string {
  return `Up to ${MAX_IMAGES_PER_MESSAGE} images and ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)} MiB total per message.`;
}
