import type { App } from "obsidian";
import type { ToolResult } from "../types";
import { PdfService } from "./service";
import type { PdfOutlineItem } from "./types";

const services = new WeakMap<App, PdfService>();
const MAX_READ_PAGES = 30;
const MAX_READ_CHARS = 30_000;
const MAX_INFO_CHARS = 12_000;
const MAX_SEARCH_CHARS = 12_000;
const DEFAULT_SEARCH_RESULTS = 8;
const MAX_SEARCH_RESULTS = 20;

function serviceFor(app: App): PdfService {
  let service = services.get(app);
  if (!service) {
    service = new PdfService(app);
    services.set(app, service);
  }
  return service;
}

export async function executePdfTool(
  app: App,
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "pdf_info":
      return pdfInfo(app, input);
    case "pdf_read":
      return pdfRead(app, input);
    case "pdf_search":
      return pdfSearch(app, input);
    default:
      return { result: `Unknown PDF tool: ${toolName}`, isError: true };
  }
}

async function pdfInfo(app: App, input: Record<string, unknown>): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) return error("'path' is required.");

  const info = await serviceFor(app).info(path);
  const lines = [`PDF: ${info.path}`, `Pages: ${info.pageCount}`];
  const metadata = Object.entries(info.metadata).filter(([, value]) => value);
  if (metadata.length > 0) {
    lines.push("", "Metadata:");
    for (const [key, value] of metadata) lines.push(`- ${key}: ${value}`);
  }
  if (info.outline.length > 0) {
    lines.push("", "Outline:", ...formatOutline(info.outline));
  } else {
    lines.push("", "Outline: (none reported by the PDF)");
  }
  return boundedResult(lines.join("\n"), MAX_INFO_CHARS, "PDF info");
}

async function pdfRead(app: App, input: Record<string, unknown>): Promise<ToolResult> {
  const path = requiredString(input.path);
  const pagesSpec = requiredString(input.pages);
  if (!path) return error("'path' is required.");
  if (!pagesSpec) return error("'pages' is required (examples: '3', '3-5', '1,4,7-10').");

  let pageNumbers: number[];
  try {
    pageNumbers = parsePageSpec(pagesSpec);
  } catch (e) {
    return error(e instanceof Error ? e.message : String(e));
  }

  if (pageNumbers.length > MAX_READ_PAGES) {
    return error(
      `Requested ${pageNumbers.length} pages. The limit is ${MAX_READ_PAGES}; request a smaller range to avoid excessive context usage.`
    );
  }

  const pages = await serviceFor(app).readPages(path, pageNumbers);
  const text = pages
    .map((page) => `--- page ${page.pageNumber} ---\n${page.displayText || "(no extractable text)"}`)
    .join("\n\n");

  if (text.length > MAX_READ_CHARS) {
    return error(
      `The requested pages contain ${text.length.toLocaleString()} characters, exceeding the ${MAX_READ_CHARS.toLocaleString()}-character tool limit. Request a smaller page range.`
    );
  }

  return { result: text, isError: false };
}

async function pdfSearch(app: App, input: Record<string, unknown>): Promise<ToolResult> {
  const path = requiredString(input.path);
  const query = requiredString(input.query);
  if (!path) return error("'path' is required.");
  if (!query) return error("'query' is required.");

  const requested = typeof input.max_results === "number" ? Math.floor(input.max_results) : DEFAULT_SEARCH_RESULTS;
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, requested));
  const hits = await serviceFor(app).search(path, query, maxResults);

  if (hits.length === 0) {
    return {
      result: `No local PDF text matches found for "${query}" in ${path}. Try a shorter or alternative phrase. Scanned/image-only PDFs may contain no extractable text.`,
      isError: false,
    };
  }

  const lines = [`Found ${hits.length} matching page(s) for "${query}" in ${path}:`];
  for (const hit of hits) {
    lines.push("", `p. ${hit.pageNumber} (${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"} on page)`, hit.snippet);
  }
  return boundedResult(lines.join("\n"), MAX_SEARCH_CHARS, "PDF search result");
}

function parsePageSpec(spec: string): number[] {
  const pages = new Set<number>();
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || end < start) {
        throw new Error(`Invalid page range: ${part}`);
      }
      if (end - start + 1 > MAX_READ_PAGES) {
        throw new Error(`Page range ${part} is too large; request at most ${MAX_READ_PAGES} pages at a time.`);
      }
      for (let page = start; page <= end; page++) pages.add(page);
      continue;
    }

    if (!/^\d+$/.test(part)) throw new Error(`Invalid page expression: ${part}`);
    const page = Number(part);
    if (page < 1) throw new Error(`Page numbers are 1-based: ${part}`);
    pages.add(page);
  }

  if (pages.size === 0) throw new Error("No page numbers were provided.");
  return Array.from(pages).sort((a, b) => a - b);
}

function formatOutline(items: PdfOutlineItem[], depth = 0): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const page = item.pageNumber ? ` (p. ${item.pageNumber})` : "";
    lines.push(`${"  ".repeat(depth)}- ${item.title}${page}`);
    lines.push(...formatOutline(item.children, depth + 1));
  }
  return lines;
}

function boundedResult(text: string, limit: number, label: string): ToolResult {
  if (text.length <= limit) return { result: text, isError: false };
  return {
    result: `${text.slice(0, limit)}\n\n[${label} truncated at ${limit.toLocaleString()} characters.]`,
    isError: false,
  };
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function error(result: string): ToolResult {
  return { result, isError: true };
}
