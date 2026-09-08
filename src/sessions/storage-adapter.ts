/**
 * Small runtime-safe storage surface used by the session subsystem.
 * Implement this with Obsidian Vault/DataAdapter methods in the integration
 * layer. No Node/Electron APIs are required.
 */
export interface SessionStorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
}
