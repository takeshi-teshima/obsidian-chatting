import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { App } from "obsidian";

/**
 * Real fs-backed fake Obsidian `App`/`DataAdapter`, rooted at a throwaway
 * directory (a `/tmp` mkdtemp scratch vault in practice). This deliberately
 * performs real disk I/O rather than an in-memory object-shape mock, per the
 * task brief's instruction that "the last two batches both benefited from
 * testing against something that behaves like real disk I/O."
 *
 * Only the subset of `DataAdapter` the session/migration code actually calls
 * is implemented: exists/read/write/remove/rename/mkdir/list/stat.
 */
export function createFakeApp(vaultRoot: string): App {
  const resolve = (p: string) => path.join(vaultRoot, p);

  const adapter = {
    async exists(p: string): Promise<boolean> {
      try {
        await fs.access(resolve(p));
        return true;
      } catch {
        return false;
      }
    },
    async read(p: string): Promise<string> {
      return fs.readFile(resolve(p), "utf8");
    },
    async write(p: string, data: string): Promise<void> {
      await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fs.writeFile(resolve(p), data, "utf8");
    },
    async remove(p: string): Promise<void> {
      await fs.rm(resolve(p), { force: true });
    },
    async rename(from: string, to: string): Promise<void> {
      await fs.mkdir(path.dirname(resolve(to)), { recursive: true });
      await fs.rename(resolve(from), resolve(to));
    },
    async mkdir(p: string): Promise<void> {
      await fs.mkdir(resolve(p), { recursive: true });
    },
    async rmdir(p: string, recursive?: boolean): Promise<void> {
      await fs.rm(resolve(p), { recursive: !!recursive, force: true });
    },
    async list(p: string): Promise<{ files: string[]; folders: string[] }> {
      const dirents = await fs.readdir(resolve(p), { withFileTypes: true });
      const files: string[] = [];
      const folders: string[] = [];
      for (const dirent of dirents) {
        const full = `${p}/${dirent.name}`;
        if (dirent.isDirectory()) folders.push(full);
        else files.push(full);
      }
      return { files, folders };
    },
    async stat(p: string): Promise<{ mtime: number; ctime: number; size: number; type: "file" | "folder" } | null> {
      try {
        const s = await fs.stat(resolve(p));
        return { mtime: s.mtimeMs, ctime: s.ctimeMs, size: s.size, type: s.isDirectory() ? "folder" : "file" };
      } catch {
        return null;
      }
    },
    async readBinary(p: string): Promise<ArrayBuffer> {
      const buf = await fs.readFile(resolve(p));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async writeBinary(p: string, data: ArrayBuffer): Promise<void> {
      await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fs.writeFile(resolve(p), Buffer.from(data));
    },
    async append(p: string, data: string): Promise<void> {
      await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fs.appendFile(resolve(p), data, "utf8");
    },
  };

  const fakeApp = {
    vault: {
      configDir: ".obsidian",
      adapter,
    },
  };

  return fakeApp as unknown as App;
}
