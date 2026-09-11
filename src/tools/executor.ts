import { App, TFile, normalizePath } from "obsidian";
import type { ToolResult } from "../types";
import { executePdfTool } from "../pdf/tools";
import { executeSkillTool } from "../skills/tools";

type AskUserCallback = (question: string) => Promise<string>;

/**
 * Executes a tool call against the Obsidian Vault API.
 * Uses docs-recommended patterns:
 * - getFileByPath() for direct file lookups
 * - cachedRead() for display-only reads
 * - vault.process() for atomic edits
 * - fileManager.renameFile() for link-aware renames
 * - fileManager.trashFile() for safe deletes
 */
export async function executeTool(
  app: App,
  toolName: string,
  input: Record<string, unknown>,
  onAskUser: AskUserCallback
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case "read_document":
        return await readDocument(app, input);
      case "edit_document":
        return await editDocument(app, input);
      case "search_vault":
        return await searchVault(app, input);
      case "read_file":
        return await readFile(app, input);
      case "create_file":
        return await createFile(app, input);
      case "list_files":
        return await listFiles(app, input);
      case "rename_file":
        return await renameFile(app, input);
      case "delete_file":
        return await deleteFile(app, input);
      case "get_properties":
        return await getProperties(app, input);
      case "set_properties":
        return await setProperties(app, input);
      case "get_backlinks":
        return await getBacklinks(app, input);
      case "get_current_datetime":
        return getCurrentDatetime();
      case "open_document":
        return await openDocument(app, input);
      case "pdf_info":
      case "pdf_read":
      case "pdf_search":
        return await executePdfTool(app, toolName, input);
      case "list_skills":
      case "read_skill":
      case "read_skill_resource":
        return await executeSkillTool(app, toolName, input);
      case "ask_user":
        return await askUser(input, onAskUser);
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `Tool error: ${msg}`, isError: true };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve a file from path or active file */
function resolveFile(app: App, path?: string): TFile | null {
  if (path) {
    return app.vault.getFileByPath(normalizePath(path));
  }
  return app.workspace.getActiveFile();
}

/** Ensure parent folders exist for a path */
async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const parentPath = filePath.substring(0, filePath.lastIndexOf("/"));
  if (parentPath && !app.vault.getFolderByPath(parentPath)) {
    await app.vault.createFolder(parentPath);
  }
}

// ─── Hidden path support ────────────────────────────────────────────────────
//
// Obsidian's Vault API (TFile/TFolder, getFileByPath/getFiles/etc.) silently
// excludes any path with a "."-prefixed segment (.obsidian, .trash, .git,
// .chatting, ...) from its index. This is not a "show hidden files" display
// setting the user can toggle - there is no such setting - it's how the
// Vault decides what counts as a file/folder in the first place, on both
// desktop and mobile.
//
// The way around it is `app.vault.adapter` (the DataAdapter interface):
// this is the same low-level, path-based read/write/list API Obsidian
// itself uses to store plugin settings under .obsidian/plugins/<id>/, and
// it behaves identically on desktop and mobile (that's its whole purpose -
// each platform implements the same interface over its own storage). It
// does no dotfile filtering at all, requires no settings changes, and has
// no visible effect on the user's file explorer/UI.
//
// Below, every read/write/list/search tool falls back to the adapter for
// paths the Vault API can't see, so agents can transparently work with
// dotfolders like .chatting/sessions/*.jsonl (including this plugin's own
// session logs) without the model needing to know any of this.

function hasDotSegment(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

/** Recursively list every file under `folder` via the raw DataAdapter,
 *  bypassing the Vault's dotfile/dotfolder exclusion entirely. */
async function adapterListRecursive(app: App, folder: string): Promise<string[]> {
  const { files, folders } = await app.vault.adapter.list(folder);
  const nested = await Promise.all(folders.map((f) => adapterListRecursive(app, f)));
  return [...files, ...nested.flat()];
}

/** Recursively create a folder chain via the DataAdapter (mkdir isn't
 *  guaranteed recursive across platforms, so walk it segment by segment). */
async function ensureFolderChainViaAdapter(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg;
    if (!(await app.vault.adapter.exists(current))) {
      await app.vault.adapter.mkdir(current);
    }
  }
}

/** Same replace_all/find_replace/insert operations as editDocument's
 *  Vault-API path, reimplemented over the raw DataAdapter for files under a
 *  dotfolder that the Vault API can't resolve to a TFile. */
async function editViaAdapter(
  app: App,
  path: string,
  operation: string,
  content: string,
  find: string | undefined,
  position: string | undefined
): Promise<ToolResult> {
  if (!(await app.vault.adapter.exists(path))) {
    return { result: `File not found: ${path}`, isError: true };
  }
  const data = await app.vault.adapter.read(path);

  switch (operation) {
    case "replace_all":
      await app.vault.adapter.write(path, content);
      return { result: `Replaced all content in ${path}.`, isError: false };

    case "find_replace": {
      if (!find) {
        return { result: "'find' parameter is required for find_replace.", isError: true };
      }
      const idx = data.indexOf(find);
      if (idx === -1) {
        return {
          result: "Could not find the specified text. Make sure it matches exactly (including whitespace and line breaks).",
          isError: true,
        };
      }
      const secondIdx = data.indexOf(find, idx + 1);
      const resultMsg = secondIdx !== -1 ? "[Note: Multiple matches found, replacing first occurrence.]\n" : "";
      const next = data.substring(0, idx) + content + data.substring(idx + find.length);
      await app.vault.adapter.write(path, next);
      return { result: `${resultMsg}Successfully replaced text in ${path}.`, isError: false };
    }

    case "insert": {
      if (!position) {
        return { result: "'position' parameter is required for insert.", isError: true };
      }
      let next: string;
      switch (position) {
        case "beginning":
          next = content + "\n" + data;
          break;
        case "end":
          next = data + "\n" + content;
          break;
        case "after_frontmatter": {
          const fmEnd = findFrontmatterEnd(data);
          next = fmEnd === -1 ? content + "\n" + data : data.substring(0, fmEnd) + "\n" + content + data.substring(fmEnd);
          break;
        }
        default:
          return { result: `Unknown position: ${position}`, isError: true };
      }
      await app.vault.adapter.write(path, next);
      return { result: `Inserted content at ${position} of ${path}.`, isError: false };
    }

    default:
      return { result: `Unknown operation: ${operation}`, isError: true };
  }
}

function findFrontmatterEnd(content: string): number {
  if (!content.startsWith("---")) return -1;
  const secondDash = content.indexOf("---", 3);
  if (secondDash === -1) return -1;
  return secondDash + 3;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ─── Tool Implementations ───────────────────────────────────────────────────

async function readDocument(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  // cachedRead() is faster for display-only reads
  const content = await app.vault.cachedRead(file);
  return { result: `# ${file.path}\n\n${content}`, isError: false };
}

async function editDocument(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const operation = requiredString(input.operation);
  const content = requiredString(input.content);
  const find = optionalString(input.find);
  const position = optionalString(input.position);

  const path = optionalString(input.path);

  if (path && hasDotSegment(normalizePath(path))) {
    return await editViaAdapter(app, normalizePath(path), operation, content, find, position);
  }

  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  switch (operation) {
    case "replace_all":
      await app.vault.modify(file, content);
      return { result: `Replaced all content in ${file.path}.`, isError: false };

    case "find_replace": {
      if (!find) {
        return { result: "'find' parameter is required for find_replace.", isError: true };
      }

      // Use vault.process() for atomic read-modify-write
      let resultMsg = "";
      let found = false;

      await app.vault.process(file, (data) => {
        const idx = data.indexOf(find);
        if (idx === -1) {
          found = false;
          return data; // Return unchanged
        }
        found = true;
        const secondIdx = data.indexOf(find, idx + 1);
        if (secondIdx !== -1) {
          resultMsg = "[Note: Multiple matches found, replacing first occurrence.]\n";
        }
        return data.substring(0, idx) + content + data.substring(idx + find.length);
      });

      if (!found) {
        return {
          result: "Could not find the specified text. Make sure it matches exactly (including whitespace and line breaks).",
          isError: true,
        };
      }

      return { result: `${resultMsg}Successfully replaced text in ${file.path}.`, isError: false };
    }

    case "insert": {
      if (!position) {
        return { result: "'position' parameter is required for insert.", isError: true };
      }

      await app.vault.process(file, (data) => {
        switch (position) {
          case "beginning":
            return content + "\n" + data;
          case "end":
            return data + "\n" + content;
          case "after_frontmatter": {
            const fmEnd = findFrontmatterEnd(data);
            if (fmEnd === -1) return content + "\n" + data;
            return data.substring(0, fmEnd) + "\n" + content + data.substring(fmEnd);
          }
          default:
            return data; // Unknown position, return unchanged
        }
      });

      if (position !== "beginning" && position !== "end" && position !== "after_frontmatter") {
        return { result: `Unknown position: ${position}`, isError: true };
      }

      return { result: `Inserted content at ${position} of ${file.path}.`, isError: false };
    }

    default:
      return { result: `Unknown operation: ${operation}`, isError: true };
  }
}

async function searchVault(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const query = requiredString(input.query).toLowerCase();
  const searchContent = input.searchContent as boolean | undefined;
  const includeHidden = input.includeHidden === true;
  const limit = Math.min((input.limit as number) || 10, 50);

  // Normal mode stays exactly as before (markdown notes only, via the
  // Vault's own index). includeHidden switches to a full recursive
  // DataAdapter walk from vault root, which also reaches dotfolders like
  // .chatting - see the "Hidden path support" note above.
  const paths = includeHidden
    ? await adapterListRecursive(app, "")
    : app.vault.getMarkdownFiles().map((f) => f.path);

  const results: string[] = [];

  for (const path of paths) {
    if (results.length >= limit) break;

    if (path.toLowerCase().includes(query)) {
      results.push(`- ${path}`);
      continue;
    }

    if (searchContent) {
      const file = app.vault.getFileByPath(path);
      // cachedRead() avoids redundant disk reads for tracked files; for
      // untracked (hidden) paths, fall back to the raw adapter and skip
      // unreadable (e.g. binary) files rather than failing the whole search.
      const content = file
        ? await app.vault.cachedRead(file)
        : await app.vault.adapter.read(path).catch(() => "");
      const lowerContent = content.toLowerCase();
      const idx = lowerContent.indexOf(query);
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 50);
        const snippet = content.substring(start, end).replace(/\n/g, " ");
        results.push(`- ${path}: ...${snippet}...`);
      }
    }
  }

  if (results.length === 0) {
    return { result: `No results found for "${query}".`, isError: false };
  }

  return {
    result: `Found ${results.length} result(s):\n${results.join("\n")}`,
    isError: false,
  };
}

async function readFile(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const normalized = normalizePath(path);
  const file = app.vault.getFileByPath(normalized);
  if (file) {
    const content = await app.vault.cachedRead(file);
    return { result: content, isError: false };
  }

  // Not indexed as a TFile - likely under a dotfolder (e.g.
  // .chatting/sessions/*.jsonl). Fall back to the raw DataAdapter, which
  // sees it fine (see the "Hidden path support" note above).
  if (await app.vault.adapter.exists(normalized)) {
    const content = await app.vault.adapter.read(normalized);
    return { result: content, isError: false };
  }

  return { result: `File not found: ${path}`, isError: true };
}

async function createFile(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = normalizePath(requiredString(input.path));
  const content = requiredString(input.content);

  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  if (hasDotSegment(path)) {
    if (await app.vault.adapter.exists(path)) {
      return { result: `File already exists: ${path}. Use edit_document to modify it.`, isError: true };
    }
    const parentPath = path.substring(0, path.lastIndexOf("/"));
    if (parentPath) {
      await ensureFolderChainViaAdapter(app, parentPath);
    }
    await app.vault.adapter.write(path, content || "");
    return { result: `Created ${path}.`, isError: false };
  }

  if (app.vault.getFileByPath(path)) {
    return { result: `File already exists: ${path}. Use edit_document to modify it.`, isError: true };
  }

  await ensureParentFolder(app, path);
  await app.vault.create(path, content || "");
  return { result: `Created ${path}.`, isError: false };
}

async function listFiles(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const folder = optionalString(input.folder);
  const extension = optionalString(input.extension);
  const normalizedFolder = folder ? normalizePath(folder) : undefined;

  // Auto-switch to the DataAdapter (see "Hidden path support" above) when
  // explicitly asked to (includeHidden) or when the requested folder itself
  // is a dotfolder the Vault API wouldn't find any files under anyway.
  const includeHidden =
    input.includeHidden === true || (normalizedFolder ? hasDotSegment(normalizedFolder) : false);

  let paths: string[];
  if (includeHidden) {
    paths = await adapterListRecursive(app, normalizedFolder ?? "");
  } else {
    let files = app.vault.getFiles();
    if (normalizedFolder) {
      files = files.filter((f) =>
        f.path.startsWith(normalizedFolder + "/") || f.path === normalizedFolder
      );
    }
    paths = files.map((f) => f.path);
  }

  if (extension) {
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    paths = paths.filter((p) => p.endsWith(ext));
  }

  paths = paths.sort();
  const capped = paths.slice(0, 100);
  const suffix = paths.length > 100 ? `\n\n(Showing 100 of ${paths.length} files)` : "";

  if (capped.length === 0) {
    return { result: "No files found matching the criteria.", isError: false };
  }

  return {
    result: capped.map((p) => `- ${p}`).join("\n") + suffix,
    isError: false,
  };
}

async function renameFile(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  const newPath = requiredString(input.new_path);

  if (!path || !newPath) {
    return { result: "Both 'path' and 'new_path' parameters are required.", isError: true };
  }

  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  const normalizedNew = normalizePath(newPath);

  if (app.vault.getAbstractFileByPath(normalizedNew)) {
    return { result: `A file already exists at: ${normalizedNew}`, isError: true };
  }

  await ensureParentFolder(app, normalizedNew);

  // fileManager.renameFile() updates all internal links automatically
  await app.fileManager.renameFile(file, normalizedNew);
  return { result: `Renamed ${path} to ${normalizedNew}.`, isError: false };
}

async function deleteFile(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  // fileManager.trashFile() respects the user's file deletion preference.
  await app.fileManager.trashFile(file);
  return { result: `Moved ${path} to trash.`, isError: false };
}

async function getProperties(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;

  if (!frontmatter) {
    return { result: `No frontmatter properties found in ${file.path}.`, isError: false };
  }

  // Remove the position metadata that Obsidian adds internally
  const clean = { ...frontmatter };
  delete clean.position;

  return { result: JSON.stringify(clean, null, 2), isError: false };
}

async function setProperties(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const props = requiredRecord(input.properties);
  if (!props) {
    return { result: "'properties' parameter must be an object.", isError: true };
  }

  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  // Use Obsidian's built-in processFrontMatter for safe YAML handling
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    for (const [key, value] of Object.entries(props)) {
      if (value === null) {
        delete frontmatter[key];
      } else {
        frontmatter[key] = value;
      }
    }
  });

  const setKeys = Object.entries(props).filter(([, v]) => v !== null).map(([k]) => k);
  const removedKeys = Object.entries(props).filter(([, v]) => v === null).map(([k]) => k);
  const parts: string[] = [];
  if (setKeys.length > 0) parts.push(`Set: ${setKeys.join(", ")}`);
  if (removedKeys.length > 0) parts.push(`Removed: ${removedKeys.join(", ")}`);

  return { result: `Updated properties in ${file.path}. ${parts.join(". ")}.`, isError: false };
}

async function getBacklinks(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  // resolvedLinks maps: source path -> { target path -> link count }
  const allLinks = app.metadataCache.resolvedLinks;
  const backlinks: string[] = [];

  for (const [sourcePath, targets] of Object.entries(allLinks)) {
    if (targets[file.path]) {
      backlinks.push(sourcePath);
    }
  }

  if (backlinks.length === 0) {
    return { result: `No backlinks found for ${file.path}.`, isError: false };
  }

  backlinks.sort();
  return {
    result: `${backlinks.length} note(s) link to ${file.path}:\n${backlinks.map((p) => `- ${p}`).join("\n")}`,
    isError: false,
  };
}

function getCurrentDatetime(): ToolResult {
  const now = new Date();
  const iso = now.toISOString();
  const local = now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  const dateOnly = now.toISOString().split("T")[0]; // YYYY-MM-DD for daily notes

  return {
    result: `Local: ${local}\nISO: ${iso}\nDate: ${dateOnly}`,
    isError: false,
  };
}

async function openDocument(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  // Open in the most recent non-chat leaf so it doesn't replace the sidebar
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);
  return { result: `Opened ${file.path}.`, isError: false };
}

async function askUser(
  input: Record<string, unknown>,
  onAskUser: AskUserCallback
): Promise<ToolResult> {
  const question = requiredString(input.question);
  if (!question) {
    return { result: "'question' parameter is required.", isError: true };
  }

  const answer = await onAskUser(question);
  return { result: answer, isError: false };
}
