export interface PdfPageText {
  pageNumber: number;
  displayText: string;
  searchText: string;
}

export interface PdfOutlineItem {
  title: string;
  pageNumber?: number;
  children: PdfOutlineItem[];
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

export interface PdfInfo {
  path: string;
  pageCount: number;
  metadata: PdfMetadata;
  outline: PdfOutlineItem[];
}

export interface PdfSearchHit {
  pageNumber: number;
  snippet: string;
  matchCount: number;
}

export interface PdfJsTextItem {
  str?: string;
  hasEOL?: boolean;
}

export interface PdfJsTextChunk {
  items?: unknown[];
}

export interface PdfJsPage {
  streamTextContent: () => ReadableStream<PdfJsTextChunk>;
  cleanup?: () => void;
}

export interface PdfJsOutlineNode {
  title?: string;
  dest?: unknown;
  items?: unknown[];
}

export interface PdfJsDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
  getMetadata?: () => Promise<unknown>;
  getOutline?: () => Promise<unknown>;
  getDestination?: (name: string) => Promise<unknown>;
  getPageIndex?: (ref: unknown) => Promise<number>;
  destroy?: () => Promise<void> | void;
}

export interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
}

export interface PdfJsLib {
  getDocument: (source: { data: ArrayBuffer }) => PdfJsLoadingTask;
}
