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
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const checkFiles = [
  "migration.check.ts",
  "concurrency.check.ts",
  "turn-model-selection.check.ts",
  "agent-loop-adapter.check.ts",
  "model-selection.check.ts",
  "model-catalog-persistence.check.ts",
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

  // Run each check in its OWN node process (own event loop), not via
  // dynamic import() in this shared process. Each check's `main()` is
  // fire-and-forget (`void main()`) internally, so awaiting import() alone
  // only waits for synchronous module evaluation, not for main() to finish
  // — with multiple check files that made their async work (timers, fs I/O)
  // interleave across files and race, occasionally flipping real assertions
  // (e.g. a queued-turn admission check) purely from cross-file scheduling
  // noise, not from an actual bug in the code under test. A subprocess per
  // file gives each check an isolated event loop and a real exit code to
  // await.
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [outfile], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) anyFailed = true;

  await fs.rm(outfile, { force: true });
}

if (anyFailed) process.exitCode = 1;
