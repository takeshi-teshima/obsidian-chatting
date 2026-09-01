import { App, TFile, normalizePath } from "obsidian";
import { BUILTIN_SKILLS, getBuiltinSkill } from "./builtins";
import type { SkillDocument, SkillMetadata } from "./types";

const SKILL_ROOT = "AI/Skills";
const MAX_SKILL_CHARS = 24_000;
const MAX_RESOURCE_CHARS = 40_000;

interface FrontmatterResult {
  data: Record<string, string | boolean>;
  body: string;
}

export class SkillService {
  constructor(private readonly app: App) {}

  async list(): Promise<SkillMetadata[]> {
    const merged = new Map<string, SkillMetadata>();
    for (const item of BUILTIN_SKILLS) merged.set(item.id, { ...item });

    for (const file of this.app.vault.getMarkdownFiles()) {
      const match = file.path.match(/^AI\/Skills\/([^/]+)\/SKILL\.md$/i);
      if (!match) continue;
      const id = normalizeId(match[1]);
      const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
      merged.set(id, {
        id,
        name: stringMeta(parsed.data.name) || id,
        description: stringMeta(parsed.data.description) || `Vault skill: ${id}`,
        userInvocable: booleanMeta(parsed.data.userInvocable, true),
        source: "vault",
      });
    }
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async read(idRaw: string): Promise<SkillDocument | null> {
    const id = normalizeId(idRaw);
    if (!id) return null;
    const path = normalizePath(`${SKILL_ROOT}/${id}/SKILL.md`);
    const file = this.app.vault.getFileByPath(path);
    if (file instanceof TFile) {
      const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
      return {
        id,
        name: stringMeta(parsed.data.name) || id,
        description: stringMeta(parsed.data.description) || `Vault skill: ${id}`,
        userInvocable: booleanMeta(parsed.data.userInvocable, true),
        source: "vault",
        body: parsed.body.slice(0, MAX_SKILL_CHARS),
      };
    }
    return getBuiltinSkill(id) ?? null;
  }

  async readResource(idRaw: string, relativePathRaw: string): Promise<string | null> {
    const id = normalizeId(idRaw);
    const relative = normalizeResourcePath(relativePathRaw);
    if (!id || !relative) return null;
    const root = normalizePath(`${SKILL_ROOT}/${id}`);
    const fullPath = normalizePath(`${root}/${relative}`);
    if (!fullPath.startsWith(root + "/")) return null;
    const file = this.app.vault.getFileByPath(fullPath);
    if (!(file instanceof TFile)) return null;
    return (await this.app.vault.cachedRead(file)).slice(0, MAX_RESOURCE_CHARS);
  }

  async catalogForPrompt(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "No Skills are available.";
    return [
      "Skills contain task-specific procedures. Use read_skill only when a listed Skill is relevant; do not load every Skill by default.",
      ...skills.map((s) => `- ${s.id}: ${s.description}${s.userInvocable ? "" : " (not user-invocable)"}`),
    ].join("\n");
  }
}

export interface SkillInvocation {
  id: string;
  rest: string;
}

export function parseExplicitSkillInvocation(text: string): SkillInvocation | null {
  const match = text.trim().match(/^\/(?:skill\s+)?([a-z0-9][a-z0-9-_]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { id: normalizeId(match[1]), rest: (match[2] ?? "").trim() };
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
}

function normalizeResourcePath(value: string): string {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some((p) => p === ".." || p === "." || !p)) return "";
  return cleaned;
}

function parseFrontmatter(content: string): FrontmatterResult {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { data: {}, body: content };
  const lines = content.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return { data: {}, body: content };
  const data: Record<string, string | boolean> = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value: string | boolean = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value === "true") value = true;
    else if (value === "false") value = false;
    data[key] = value;
  }
  return { data, body: lines.slice(end + 1).join("\n").trim() };
}

function stringMeta(value: string | boolean | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
function booleanMeta(value: string | boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
