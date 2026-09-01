import type { App, TFile } from "obsidian";
import {
  destroyPdfDocument,
  extractPdfPageText,
  openPdfDocument,
  readPdfMetadata,
  readPdfOutline,
  resolvePdfFile,
} from "./engine";
import type { PdfInfo, PdfPageText } from "./types";

const MAX_CACHED_PDFS = 3;

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
