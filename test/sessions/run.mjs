// Bundles migration.check.ts (plain TS, no Svelte/Obsidian runtime deps —
// only `import type` from "obsidian", which esbuild erases) with esbuild
// (already a devDependency; no new dependency added) and runs it under
// plain Node. This is the closest equivalent to the kit's tests/*.test.ts
// this repo's toolchain supports without adding a test-framework dependency.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(os.tmpdir(), `chatting-v4-migration-check-${Date.now()}.mjs`);

await esbuild.build({
  entryPoints: [path.join(here, "migration.check.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  loader: { ".json": "json" },
});

const { default: run } = await import(outfile).catch(async (e) => {
  // If the module has no default export (it's a script with side effects),
  // importing it is enough to execute main().
  if (e instanceof Error && e.message.includes("does not provide")) return { default: null };
  throw e;
});
void run;

await fs.rm(outfile, { force: true });
