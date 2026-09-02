import type { SessionQuery, SessionQueryResult, SessionSummary } from "./types";

export const DEFAULT_SESSION_PAGE_SIZE = 60;
export const MAX_SESSION_PAGE_SIZE = 200;

export function querySessionSummaries(
  active: readonly SessionSummary[],
  archived: readonly SessionSummary[],
  query: SessionQuery,
): SessionQueryResult {
  const source = query.scope === "archived" ? archived : active;
  const normalized = normalizeSearch(query.search ?? "");
  const sort = query.sort ?? "activity";
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, Math.floor(query.limit ?? DEFAULT_SESSION_PAGE_SIZE)));

  let filtered = source.filter((item) => {
    if (query.scope === "pinned" && !item.isPinned) return false;
    if (query.scope !== "archived" && item.isArchived) return false;
    if (query.scope === "archived" && !item.isArchived) return false;
    return matchesSearch(item, normalized);
  });

  filtered = [...filtered].sort((a, b) => compareSummary(a, b, sort));
  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + items.length < filtered.length ? offset + items.length : null;
  return { items, total: filtered.length, offset, nextOffset };
}

export function compareSummary(
  left: SessionSummary,
  right: SessionSummary,
  sort: "activity" | "created" = "activity",
): number {
  // Pinned sessions remain first in active/pinned views, then normal sort.
  const pinned = Number(right.isPinned) - Number(left.isPinned);
  if (pinned !== 0) return pinned;
  const leftTime = sort === "created" ? left.createdAt : left.lastActivityAt;
  const rightTime = sort === "created" ? right.createdAt : right.lastActivityAt;
  return rightTime - leftTime
    || left.title.localeCompare(right.title, undefined, { sensitivity: "base", numeric: true })
    || left.id.localeCompare(right.id);
}

export function normalizeSearch(input: string): string[] {
  return input
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function matchesSearch(summary: SessionSummary, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    summary.title,
    summary.preview,
    summary.preferences.provider,
    summary.preferences.model,
    summary.preferences.profileId ?? "",
  ].join("\n").toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export interface DateSection {
  key: "today" | "yesterday" | "week" | "older";
  label: string;
  sessions: SessionSummary[];
}

export function groupSessionsByRecency(
  sessions: readonly SessionSummary[],
  now = Date.now(),
): DateSection[] {
  const day = 24 * 60 * 60 * 1000;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const today = startToday.getTime();
  const buckets: DateSection[] = [
    { key: "today", label: "Today", sessions: [] },
    { key: "yesterday", label: "Yesterday", sessions: [] },
    { key: "week", label: "Previous 7 days", sessions: [] },
    { key: "older", label: "Older", sessions: [] },
  ];

  for (const session of sessions) {
    const t = session.lastActivityAt;
    if (t >= today) buckets[0].sessions.push(session);
    else if (t >= today - day) buckets[1].sessions.push(session);
    else if (t >= today - 7 * day) buckets[2].sessions.push(session);
    else buckets[3].sessions.push(session);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}
