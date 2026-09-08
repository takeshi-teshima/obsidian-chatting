import { App, TFile, normalizePath } from "obsidian";
import type { ReasoningEffort } from "../model/reasoning";
import type { EffectiveProfileSettings, PromptProfile, PromptProfileMetadata } from "./types";

const PROFILE_ROOT = "AI/Prompts";
const MAX_PROFILE_CHARS = 16_000;
const VALID_EFFORTS = new Set<ReasoningEffort>(["auto", "low", "medium", "high", "max"]);

export class PromptProfileService {
  constructor(private readonly app: App) {}

  list(): PromptProfileMetadata[] {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(PROFILE_ROOT + "/"))
      .map((f) => ({
        id: profileIdFromPath(f.path),
        name: f.basename,
        description: `Prompt profile from ${f.path}`,
        source: "vault" as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(idRaw: string): Promise<PromptProfile | null> {
    const id = normalizeProfileId(idRaw);
    if (!id) return null;
    const file = this.findById(id);
    if (!(file instanceof TFile)) return null;
    const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
    return {
      id,
      name: stringValue(parsed.data.name) || file.basename,
      description: stringValue(parsed.data.description) || `Prompt profile from ${file.path}`,
      source: "vault",
      model: optionalString(parsed.data.model),
      effort: parseEffort(parsed.data.effort),
      webSearch: optionalBoolean(parsed.data.webSearch),
      skills: parseStringList(parsed.data.skills),
      instructions: parsed.body.slice(0, MAX_PROFILE_CHARS).trim(),
    };
  }

  async resolve(
    id: string | null | undefined,
    global: { model: string; effort: ReasoningEffort; enableWebSearch: boolean },
  ): Promise<{ profile: PromptProfile | null; effective: EffectiveProfileSettings }> {
    const profile = id ? await this.read(id) : null;
    return {
      profile,
      effective: {
        model: profile?.model || global.model,
        effort: profile?.effort || global.effort,
        enableWebSearch: profile?.webSearch ?? global.enableWebSearch,
        profileInstructions: profile?.instructions || undefined,
        skillAllowlist: profile?.skills,
      },
    };
  }

  private findById(id: string): TFile | null {
    const exact = this.app.vault.getFileByPath(normalizePath(`${PROFILE_ROOT}/${id}.md`));
    if (exact instanceof TFile) return exact;
    return this.app.vault.getMarkdownFiles().find((f) => profileIdFromPath(f.path) === id) ?? null;
  }
}

function profileIdFromPath(path: string): string {
  const relative = path.replace(/^AI\/Prompts\//i, "").replace(/\.md$/i, "");
  return normalizeProfileId(relative.replace(/\//g, "--"));
}

function normalizeProfileId(value: string): string {
  return value.trim().toLowerCase().replace(/\.md$/i, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

type Meta = Record<string, string | boolean | string[]>;
function parseFrontmatter(content: string): { data: Meta; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { data: {}, body: content };
  const lines = content.split(/\r?\n/);
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (end < 0) return { data: {}, body: content };
  const boundary = end + 1;
  const data: Meta = {};
  for (const line of lines.slice(1, boundary)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (raw === "true" || raw === "false") data[key] = raw === "true";
    else if (raw.startsWith("[") && raw.endsWith("]")) data[key] = raw.slice(1, -1).split(",").map((v) => unquote(v.trim())).filter(Boolean);
    else data[key] = unquote(raw);
  }
  return { data, body: lines.slice(boundary + 1).join("\n") };
}
function unquote(v: string): string { return v.replace(/^['"]|['"]$/g, ""); }
function stringValue(v: Meta[string] | undefined): string { return typeof v === "string" ? v.trim() : ""; }
function optionalString(v: Meta[string] | undefined): string | undefined { const s = stringValue(v); return s || undefined; }
function optionalBoolean(v: Meta[string] | undefined): boolean | undefined { return typeof v === "boolean" ? v : undefined; }
function parseStringList(v: Meta[string] | undefined): string[] | undefined { return Array.isArray(v) ? v.map((s) => s.trim()).filter(Boolean) : undefined; }
function parseEffort(v: Meta[string] | undefined): ReasoningEffort | undefined {
  const value = stringValue(v) as ReasoningEffort;
  return VALID_EFFORTS.has(value) ? value : undefined;
}
