export type ContextRefKind = "pdf" | "image";

/** JSON-safe reference to a vault asset. Never stores file bytes or base64. */
export interface ContextRef {
  id: string;
  kind: ContextRefKind;
  path: string;
  name: string;
  mime: string;
  size: number;
  mtime: number;
}

/** Alias retained for image-oriented code introduced in the next delivery. */
export type AttachmentRef = ContextRef;

export function isContextRef(value: unknown): value is ContextRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" &&
    (v.kind === "pdf" || v.kind === "image") &&
    typeof v.path === "string" &&
    typeof v.name === "string" &&
    typeof v.mime === "string" &&
    typeof v.size === "number" && Number.isFinite(v.size) && v.size >= 0 &&
    typeof v.mtime === "number" && Number.isFinite(v.mtime) && v.mtime >= 0;
}

export function contextRefFingerprint(ref: Pick<ContextRef, "kind" | "path" | "size" | "mtime">): string {
  return `${ref.kind}:${ref.path}:${ref.size}:${ref.mtime}`;
}
