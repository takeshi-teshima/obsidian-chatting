import { App, TFile, normalizePath } from "obsidian";
import type {
  PdfJsDocument,
  PdfJsLib,
  PdfJsOutlineNode,
  PdfMetadata,
  PdfOutlineItem,
  PdfPageText,
} from "./types";
import { normalizeDisplayText, normalizeSearchText } from "./normalize";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getPdfJsLib(): PdfJsLib {
  const candidate = (window as Window & { pdfjsLib?: PdfJsLib }).pdfjsLib;
  if (!candidate?.getDocument) {
    throw new Error(
      "Obsidian's bundled PDF.js is unavailable. Reload Obsidian or update the PDF adapter."
    );
  }
  return candidate;
}

export function resolvePdfFile(app: App, path: string): TFile {
  const normalized = normalizePath(path);
  const file = app.vault.getFileByPath(normalized);
  if (!file) throw new Error(`PDF not found: ${path}`);
  if (file.extension.toLowerCase() !== "pdf") {
    throw new Error(`Not a PDF file: ${path}`);
  }
  return file;
}

export async function openPdfDocument(app: App, file: TFile): Promise<PdfJsDocument> {
  const data = await app.vault.readBinary(file);
  const loadingTask = getPdfJsLib().getDocument({ data });
  return loadingTask.promise;
}

export async function destroyPdfDocument(document: PdfJsDocument): Promise<void> {
  try {
    await document.destroy?.();
  } catch {
    // Cleanup is best-effort and must not mask a successful tool result.
  }
}

export async function extractPdfPageText(
  document: PdfJsDocument,
  pageNumber: number
): Promise<PdfPageText> {
  const page = await document.getPage(pageNumber);
  const fragments: string[] = [];

  try {
    // streamTextContent + an explicit reader is friendlier to mobile Safari
    // than building one large TextContent object in a single call.
    const reader = page.streamTextContent().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || !Array.isArray(value.items)) continue;

        for (const rawItem of value.items) {
          if (!isRecord(rawItem)) continue;
          const str = typeof rawItem.str === "string" ? rawItem.str : "";
          if (!str) continue;
          fragments.push(str);
          fragments.push(rawItem.hasEOL === true ? "\n" : " ");
        }
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    try {
      page.cleanup?.();
    } catch {
      // Best-effort cleanup for mobile memory pressure.
    }
  }

  const rawText = fragments.join("");
  const displayText = normalizeDisplayText(rawText);
  return {
    pageNumber,
    displayText,
    searchText: normalizeSearchText(displayText),
  };
}

export async function readPdfMetadata(document: PdfJsDocument): Promise<PdfMetadata> {
  if (!document.getMetadata) return {};
  try {
    const raw = await document.getMetadata();
    if (!isRecord(raw) || !isRecord(raw.info)) return {};
    const info = raw.info;
    return {
      title: optionalString(info.Title),
      author: optionalString(info.Author),
      subject: optionalString(info.Subject),
      keywords: optionalString(info.Keywords),
      creator: optionalString(info.Creator),
      producer: optionalString(info.Producer),
    };
  } catch {
    return {};
  }
}

function toOutlineNode(value: unknown): PdfJsOutlineNode | null {
  if (!isRecord(value)) return null;
  return {
    title: optionalString(value.title),
    dest: value.dest,
    items: Array.isArray(value.items) ? value.items : [],
  };
}

async function resolveOutlinePage(
  document: PdfJsDocument,
  dest: unknown
): Promise<number | undefined> {
  if (!document.getPageIndex || dest == null) return undefined;

  try {
    let resolved: unknown = dest;
    if (typeof dest === "string" && document.getDestination) {
      resolved = await document.getDestination(dest);
    }
    if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
    const index = await document.getPageIndex(resolved[0]);
    return Number.isInteger(index) ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}

async function convertOutlineNodes(
  document: PdfJsDocument,
  values: unknown[],
  remaining: { count: number }
): Promise<PdfOutlineItem[]> {
  const result: PdfOutlineItem[] = [];
  for (const value of values) {
    if (remaining.count <= 0) break;
    const node = toOutlineNode(value);
    if (!node?.title) continue;
    remaining.count -= 1;
    result.push({
      title: node.title,
      pageNumber: await resolveOutlinePage(document, node.dest),
      children: await convertOutlineNodes(document, node.items ?? [], remaining),
    });
  }
  return result;
}

export async function readPdfOutline(document: PdfJsDocument): Promise<PdfOutlineItem[]> {
  if (!document.getOutline) return [];
  try {
    const raw = await document.getOutline();
    if (!Array.isArray(raw)) return [];
    // Bound outline traversal so pathological PDFs cannot create huge tool output.
    return convertOutlineNodes(document, raw, { count: 150 });
  } catch {
    return [];
  }
}
