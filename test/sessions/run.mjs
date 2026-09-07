// Bundles each *.check.ts in this directory (plain TS, no Svelte/Obsidian
// runtime deps — only `import type` from "obsidian", which esbuild erases)
// with esbuild (already a devDependency; no new dependency added) and runs
// each under plain Node. This is the closest equivalent to the kit's
// tests/*.test.ts this repo's toolchain supports without adding a
// test-framework dependency.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkFiles = [
  "migration.check.ts",
  "concurrency.check.ts",
  "turn-model-selection.check.ts",
  "agent-loop-adapter.check.ts",
];

let anyFailed = false;
for (const file of checkFiles) {
  console.log(`\n########## ${file} ##########`);
  const outfile = path.join(os.tmpdir(), `chatting-v4-${file}-${Date.now()}.mjs`);
  await esbuild.build({
    entryPoints: [path.join(here, file)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile,
    loader: { ".json": "json" },
  });

  const before = process.exitCode;
  process.exitCode = undefined;
  await import(outfile).catch(async (e) => {
    // If the module has no default export (it's a script with side effects),
    // importing it is enough to execute main().
    if (e instanceof Error && e.message.includes("does not provide")) return;
    throw e;
  });
  if (process.exitCode) anyFailed = true;
  process.exitCode = before;

  await fs.rm(outfile, { force: true });
}

if (anyFailed) process.exitCode = 1;
