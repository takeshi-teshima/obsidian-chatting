export function normalizeDisplayText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    // Rejoin common Latin line-end hyphenation: "meth-\nod" -> "method".
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSearchText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}
