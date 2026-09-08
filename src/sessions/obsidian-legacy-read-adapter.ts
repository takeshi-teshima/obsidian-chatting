import type { App } from "obsidian";
import type { LegacyReadAdapter } from "./migration/legacy-adapter";

/** Read-only `LegacyReadAdapter` backed by a real Obsidian `App`'s vault adapter. */
export class ObsidianLegacyReadAdapter implements LegacyReadAdapter {
  constructor(private readonly app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!await this.app.vault.adapter.exists(path)) return { files: [], folders: [] };
    const listed = await this.app.vault.adapter.list(path);
    return { files: listed.files, folders: listed.folders };
  }

  async stat(path: string): Promise<{ mtime: number; ctime: number } | null> {
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat) return null;
    return { mtime: stat.mtime, ctime: stat.ctime };
  }
}
