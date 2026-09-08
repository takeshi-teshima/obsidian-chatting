import { groupSessionsByRecency } from "./catalog";
import type { SessionQueryResult, SessionRunPhase, SessionSummary } from "./types";

export interface SessionBrowserRow extends SessionSummary {
  runtimePhase: SessionRunPhase;
}

export interface SessionBrowserSection {
  key: string;
  label: string;
  rows: SessionBrowserRow[];
}

export function buildSessionBrowserSections(
  result: SessionQueryResult,
  runtimePhases: ReadonlyMap<string, SessionRunPhase>,
  groupByDate: boolean,
): SessionBrowserSection[] {
  const rows: SessionBrowserRow[] = result.items.map((item) => ({
    ...item,
    runtimePhase: runtimePhases.get(item.id) ?? "idle",
  }));
  if (!groupByDate) return [{ key: "all", label: "", rows }];
  return groupSessionsByRecency(rows).map((section) => ({
    key: section.key,
    label: section.label,
    rows: section.sessions.map((session) => ({
      ...session,
      runtimePhase: runtimePhases.get(session.id) ?? "idle",
    })),
  }));
}

export function formatRelativeSessionTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "now";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  try { return new Date(timestamp).toLocaleDateString(); } catch { return ""; }
}
