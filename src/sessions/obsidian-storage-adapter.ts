import type { App } from "obsidian";
import type { SessionStorageAdapter } from "./storage-adapter";

/**
 * Obsidian Vault/DataAdapter-backed implementation of `SessionStorageAdapter`.
 *
 * All paths are vault-relative (e.g. `.chatting/session-metadata/<id>.meta.json`),
 * NOT rooted under `app.vault.configDir`/plugin data. This is intentional: a
 * future Claudian integration expects `.chatting/` to sit at the vault root
 * alongside `.obsidian/`, so the same bytes can be relocated/exposed without a
 * schema migration. See STORAGE_AND_SCALE.md in the v4 kit.
 *
 * Only Obsidian DataAdapter primitives are used — no Node/Electron APIs — so
 * this remains mobile-safe.
 */
export class ObsidianSessionStorageAdapter implements SessionStorageAdapter {
  constructor(private readonly app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, contents: string): Promise<void> {
    await this.ensureParentFolder(path);
    await this.app.vault.adapter.write(path, contents);
  }

  async remove(path: string): Promise<void> {
    await this.app.vault.adapter.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureParentFolder(to);
    await this.app.vault.adapter.rename(from, to);
  }

  async ensureFolder(path: string): Promise<void> {
    if (!path || await this.app.vault.adapter.exists(path)) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    try {
      await this.app.vault.adapter.mkdir(path);
    } catch {
      // Another concurrent writer may have created it first.
    }
  }

  async listFiles(path: string): Promise<string[]> {
    if (!await this.app.vault.adapter.exists(path)) return [];
    const listed = await this.app.vault.adapter.list(path);
    return listed.files;
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
  }
}
