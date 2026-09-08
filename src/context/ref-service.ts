import { App, TFile, normalizePath } from "obsidian";
import type { ContextRef, ContextRefKind } from "./refs";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

export class ContextRefService {
  constructor(private readonly app: App) {}

  fromFile(file: TFile, expectedKind?: ContextRefKind): ContextRef | null {
    const kind = kindForFile(file);
    if (!kind || (expectedKind && kind !== expectedKind)) return null;
    const mime = kind === "pdf" ? "application/pdf" : IMAGE_MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
    const id = stableId(`${kind}\n${file.path}\n${file.stat.size}\n${file.stat.mtime}`);
    return {
      id,
      kind,
      path: file.path,
      name: file.name,
      mime,
      size: file.stat.size,
      mtime: file.stat.mtime,
    };
  }

  resolvePath(pathRaw: string, expectedKind?: ContextRefKind): ContextRef | null {
    const path = normalizePath(stripWikiLink(pathRaw.trim()));
    const direct = this.app.vault.getFileByPath(path);
    if (direct instanceof TFile) return this.fromFile(direct, expectedKind);

    const lower = path.toLowerCase();
    const candidates = this.app.vault.getFiles().filter((f) =>
      f.path.toLowerCase() === lower || f.name.toLowerCase() === lower || f.basename.toLowerCase() === lower.replace(/\.[^.]+$/, "")
    );
    const valid = candidates.map((f) => this.fromFile(f, expectedKind)).filter((v): v is ContextRef => !!v);
    return valid.length === 1 ? valid[0] : null;
  }

  inspect(ref: ContextRef): { exists: boolean; stale: boolean; current?: ContextRef } {
    const file = this.app.vault.getFileByPath(normalizePath(ref.path));
    if (!(file instanceof TFile)) return { exists: false, stale: true };
    const current = this.fromFile(file, ref.kind);
    if (!current) return { exists: true, stale: true };
    return { exists: true, stale: current.size !== ref.size || current.mtime !== ref.mtime, current };
  }
}

export function kindForFile(file: TFile): ContextRefKind | null {
  const ext = file.extension.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif") return "image";
  return null;
}

function stripWikiLink(value: string): string {
  if (value.startsWith("[[") && value.endsWith("]]")) return value.slice(2, -2).split("|")[0].trim();
  return value.replace(/^['"]|['"]$/g, "");
}

function stableId(input: string): string {
  // FNV-1a-style 32-bit hash: deterministic, synchronous, browser-safe. This is an identifier, not a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ctx_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
