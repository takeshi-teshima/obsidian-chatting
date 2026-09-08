import type { SessionStorageAdapter } from "../storage-adapter";

/**
 * Which session id the plugin's single visible pane is currently bound to.
 * This is transient runtime/UI-binding state per MIGRATION_HANDOFF.md §5
 * ("current ChatView binding" is explicitly listed as NOT canonical
 * metadata) — it lives under `.chatting/runtime/`, never inside a
 * SessionMetadata record.
 *
 * NOTE: this plugin currently binds exactly one active session to its single
 * chat pane (the pre-existing branch-10 UX). Multi-session concurrent
 * SessionManager/UI (SessionSwitcher/Browser/TabStrip, per-session runtimes)
 * from the Session Workspaces v3 experiment was intentionally NOT re-ported
 * in this pass — see the migration report for the scope decision. This file
 * only tracks the one active binding; a future multi-pane port would extend
 * it to a list.
 */
const ACTIVE_SESSION_PATH = ".chatting/runtime/active-session.json";

export async function loadActiveSessionId(adapter: SessionStorageAdapter): Promise<string | null> {
  if (!await adapter.exists(ACTIVE_SESSION_PATH)) return null;
  try {
    const parsed: unknown = JSON.parse(await adapter.read(ACTIVE_SESSION_PATH));
    const id = (parsed as { id?: unknown })?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function saveActiveSessionId(adapter: SessionStorageAdapter, id: string): Promise<void> {
  await adapter.ensureFolder(".chatting/runtime");
  await adapter.write(ACTIVE_SESSION_PATH, JSON.stringify({ id }, null, 2));
}
