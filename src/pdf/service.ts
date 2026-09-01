import type { App, TFile } from "obsidian";
import {
  destroyPdfDocument,
  extractPdfPageText,
  openPdfDocument,
  readPdfMetadata,
  readPdfOutline,
  resolvePdfFile,
} from "./engine";
import { normalizeSearchText } from "./normalize";
import type { PdfInfo, PdfPageText, PdfSearchHit } from "./types";

const MAX_CACHED_PDFS = 3;
const YIELD_EVERY_PAGES = 8;

interface PdfCacheEntry {
  key: string;
  path: string;
  pageCount: number;
  pages: Map<number, PdfPageText>;
  info?: PdfInfo;
  touchedAt: number;
}

export class PdfService {
  private readonly cache = new Map<string, PdfCacheEntry>();

  constructor(private readonly app: App) {}

  async info(path: string): Promise<PdfInfo> {
    const file = resolvePdfFile(this.app, path);
    const entry = this.getEntry(file);
    if (entry.info) {
      this.touch(entry);
      return entry.info;
    }

    const document = await openPdfDocument(this.app, file);
    try {
      entry.pageCount = document.numPages;
      entry.info = {
        path: file.path,
        pageCount: document.numPages,
        metadata: await readPdfMetadata(document),
        outline: await readPdfOutline(document),
      };
      this.touch(entry);
      return entry.info;
    } finally {
      await destroyPdfDocument(document);
    }
  }

  async readPages(path: string, pageNumbers: number[]): Promise<PdfPageText[]> {
    const file = resolvePdfFile(this.app, path);
    const entry = this.getEntry(file);

    const document = await openPdfDocument(this.app, file);
    try {
      entry.pageCount = document.numPages;
      for (const pageNumber of pageNumbers) {
        this.assertPageNumber(pageNumber, entry.pageCount);
        if (!entry.pages.has(pageNumber)) {
          entry.pages.set(
            pageNumber,
            await extractPdfPageText(document, pageNumber)
          );
        }
      }
    } finally {
      await destroyPdfDocument(document);
    }

    this.touch(entry);
    return pageNumbers.map((page) => entry.pages.get(page)!).filter(Boolean);
  }

  async search(path: string, query: string, maxResults: number): Promise<PdfSearchHit[]> {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return [];

    const file = resolvePdfFile(this.app, path);
    const entry = this.getEntry(file);
    const hits: PdfSearchHit[] = [];
    const document = await openPdfDocument(this.app, file);

    try {
      entry.pageCount = document.numPages;
      for (let pageNumber = 1; pageNumber <= entry.pageCount; pageNumber++) {
        let page = entry.pages.get(pageNumber);
        if (!page) {
          page = await extractPdfPageText(document, pageNumber);
          entry.pages.set(pageNumber, page);
        }

        const firstIndex = page.searchText.indexOf(normalizedQuery);
        if (firstIndex !== -1) {
          hits.push({
            pageNumber,
            snippet: buildSnippet(page.searchText, firstIndex, normalizedQuery.length),
            matchCount: countMatches(page.searchText, normalizedQuery),
          });
          if (hits.length >= maxResults) break;
        }

        if (pageNumber % YIELD_EVERY_PAGES === 0) {
          await yieldToUi();
        }
      }
    } finally {
      await destroyPdfDocument(document);
    }

    this.touch(entry);
    return hits;
  }

  private getEntry(file: TFile): PdfCacheEntry {
    const key = `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    // Drop stale versions of the same path.
    for (const [candidateKey, candidate] of this.cache) {
      if (candidate.path === file.path) this.cache.delete(candidateKey);
    }

    const entry: PdfCacheEntry = {
      key,
      path: file.path,
      pageCount: 0,
      pages: new Map(),
      touchedAt: Date.now(),
    };
    this.cache.set(key, entry);
    this.evictIfNeeded();
    return entry;
  }

  private touch(entry: PdfCacheEntry): void {
    entry.touchedAt = Date.now();
  }

  private evictIfNeeded(): void {
    while (this.cache.size > MAX_CACHED_PDFS) {
      let oldestKey: string | undefined;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.touchedAt < oldestTime) {
          oldestTime = entry.touchedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      this.cache.delete(oldestKey);
    }
  }

  private assertPageNumber(pageNumber: number, pageCount: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
      throw new Error(`Page ${pageNumber} is outside the valid range 1-${pageCount}.`);
    }
  }
}

function countMatches(text: string, query: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const index = text.indexOf(query, from);
    if (index === -1) return count;
    count += 1;
    from = index + Math.max(1, query.length);
  }
}

function buildSnippet(text: string, index: number, queryLength: number): string {
  const radius = 260;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + queryLength + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
