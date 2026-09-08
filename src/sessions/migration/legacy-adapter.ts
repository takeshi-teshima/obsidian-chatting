/**
 * Minimal read-only surface migration scanners need against legacy source
 * trees (Session Workspaces v3's sharded store, branch-11's flat store, and
 * the single legacy chat-state.json). This intentionally mirrors Obsidian's
 * `DataAdapter` shape (`app.vault.adapter`) so the same scanner code runs
 * unchanged against a real `App` in the plugin and against a real
 * fs-backed fake `App`/`DataAdapter` in tests — never a bare in-memory mock.
 */
export interface LegacyReadAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  stat(path: string): Promise<{ mtime: number; ctime: number } | null>;
}
