// Regression check for a real bug: `normalizeSettings()` (src/settings-normalize.ts,
// called from ChatPlugin.loadSettings()) used to be a strict allowlist of
// known field names. Every settings field added after that allowlist was
// last updated (`lastSelectedChatModel`, `customModelCatalog`, `sendOnEnter`,
// `titleGenerationEnabled`, `titleGeneration`) was silently dropped from
// memory on every plugin reload, even though the file on disk still had the
// correct value — until the next unrelated `saveSettings()` call overwrote
// the file with the now-stripped value. This surfaced as a real user report:
// a customized model catalog order "disappeared" after routine reloads.
//
// This check simulates the exact `loadSettings()` reload cycle
// (`normalizeSettings(await loadData()) merged under DEFAULT_SETTINGS`) and
// asserts that every non-allowlisted field survives it — including a
// made-up field that doesn't exist yet, so this test keeps guarding the
// underlying design property (no per-field allowlist to forget to update),
// not just today's specific field names.
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type ChatSettings } from "../../src/types";
import { normalizeSettings } from "../../src/settings-normalize";

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  FAIL - ${name}`);
    console.error(error);
    process.exitCode = 1;
    throw error;
  }
}

/** Mimics the exact merge `ChatPlugin.loadSettings()` performs. */
function simulateReload(onDiskJson: unknown): ChatSettings {
  const saved = normalizeSettings(onDiskJson);
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** Mimics `plugin.saveData()`'s JSON round-trip (Obsidian just does `JSON.stringify`/parse under the hood). */
function toDiskJson(settings: ChatSettings): unknown {
  return JSON.parse(JSON.stringify(settings));
}

function main(): void {
  console.log("== settings round-trip: newly-added fields survive a reload, not just a save ==");

  check("customModelCatalog survives loadSettings() after a simulated reload", () => {
    const before: ChatSettings = {
      ...DEFAULT_SETTINGS,
      customModelCatalog: { anthropic: [{ value: "claude-x", label: "Claude X" }] },
    };
    const after = simulateReload(toDiskJson(before));
    assert.deepEqual(after.customModelCatalog, before.customModelCatalog);
  });

  check("sendOnEnter=true (a non-default value) survives a reload", () => {
    const before: ChatSettings = { ...DEFAULT_SETTINGS, sendOnEnter: true };
    const after = simulateReload(toDiskJson(before));
    assert.equal(after.sendOnEnter, true);
  });

  check("titleGenerationEnabled=false (a non-default value) survives a reload", () => {
    const before: ChatSettings = { ...DEFAULT_SETTINGS, titleGenerationEnabled: false };
    const after = simulateReload(toDiskJson(before));
    assert.equal(after.titleGenerationEnabled, false);
  });

  check("titleGeneration override survives a reload", () => {
    const before: ChatSettings = {
      ...DEFAULT_SETTINGS,
      titleGeneration: { provider: "openai", model: "gpt-4o" },
    };
    const after = simulateReload(toDiskJson(before));
    assert.deepEqual(after.titleGeneration, before.titleGeneration);
  });

  check("lastSelectedChatModel survives a reload", () => {
    const before: ChatSettings = {
      ...DEFAULT_SETTINGS,
      lastSelectedChatModel: { providerId: "anthropic", model: "claude-opus-4-7" },
    };
    const after = simulateReload(toDiskJson(before));
    assert.deepEqual(after.lastSelectedChatModel, before.lastSelectedChatModel);
  });

  check("a field that doesn't exist YET (future-proofing) still survives a reload unmodified", () => {
    const onDisk = { ...toDiskJson({ ...DEFAULT_SETTINGS }) as Record<string, unknown>, someFutureSetting: { nested: [1, 2, 3] } };
    const after = normalizeSettings(onDisk) as Record<string, unknown>;
    assert.deepEqual(after.someFutureSetting, { nested: [1, 2, 3] });
  });

  check("multiple reloads in a row (repeated app:reload) are stable, not progressively lossy", () => {
    let settings: ChatSettings = {
      ...DEFAULT_SETTINGS,
      customModelCatalog: { "chatgpt-oauth": [{ value: "gpt-5.5", label: "GPT-5.5" }] },
      sendOnEnter: true,
    };
    for (let i = 0; i < 5; i++) {
      settings = simulateReload(toDiskJson(settings));
    }
    assert.deepEqual(settings.customModelCatalog, { "chatgpt-oauth": [{ value: "gpt-5.5", label: "GPT-5.5" }] });
    assert.equal(settings.sendOnEnter, true);
  });

  // Sanity check that the defensive re-validation this function still does
  // (the reason it isn't a pure passthrough) actually works: a corrupted
  // enum-shaped field must still be dropped/defaulted, not blindly trusted.
  check("a corrupt/invalid reasoningEffort value is still defensively dropped, not passed through", () => {
    const onDisk = { ...toDiskJson({ ...DEFAULT_SETTINGS }) as Record<string, unknown>, reasoningEffort: "not-a-real-value" };
    const after = simulateReload(onDisk);
    assert.equal(after.reasoningEffort, DEFAULT_SETTINGS.reasoningEffort);
  });

  check("a corrupt/invalid provider value is still defensively dropped, not passed through", () => {
    const onDisk = { ...toDiskJson({ ...DEFAULT_SETTINGS }) as Record<string, unknown>, provider: "not-a-real-provider" };
    const after = simulateReload(onDisk);
    assert.equal(after.provider, DEFAULT_SETTINGS.provider);
  });

  console.log(`\n${passed} checks passed.`);
}

main();
