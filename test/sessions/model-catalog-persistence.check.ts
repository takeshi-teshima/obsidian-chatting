// Regression check for the "fetched/added models vanish on Obsidian restart
// and don't sync across devices" bug: the model catalog UI used to be backed
// by a module-level in-memory `Map` (settings.ts's old `modelCache`) that was
// never written to `ChatSettings`/`data.json`. This exercises the same code
// path the Settings tab's "Model catalog" section uses
// (`setSettingsSource` + `getModelOptions` from src/settings.ts) and proves
// the catalog now round-trips through a serialize/deserialize cycle that
// mimics `saveData()`/`loadData()`.
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type ChatSettings } from "../../src/types";
import { getModelOptions, getModelDisplayName, setSettingsSource } from "../../src/model-catalog";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok - ${name}`); })
    .catch((error) => {
      console.error(`  FAIL - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

/** Simulates plugin.saveData()/loadData(): a plain JSON round-trip. */
function simulateRestart(settings: ChatSettings): ChatSettings {
  return JSON.parse(JSON.stringify(settings));
}

async function main(): Promise<void> {
  console.log("== model catalog: persisted (not in-memory) across a simulated restart ==");

  // Live settings object the same way ChatPlugin.onload() wires it up:
  // `setSettingsSource(() => this.settings)` — a getter, not a snapshot, so
  // reassigning `settings` (as loadSettings() does) is picked up live.
  let settings: ChatSettings = { ...DEFAULT_SETTINGS };
  setSettingsSource(() => settings);

  await check("with no fetch/custom entries yet, getModelOptions falls back to the bundled list", () => {
    const anthropicModels = getModelOptions("anthropic");
    assert.ok(anthropicModels.length > 0);
    assert.equal(settings.customModelCatalog, undefined);
  });

  await check("simulated 'Fetch' click writes into customModelCatalog and getModelOptions reflects it", () => {
    // This mirrors renderModelSection()'s refresh-button handler.
    const fetched = [
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-opus-5", label: "Claude Opus 5 (fetched)" },
    ];
    settings = { ...settings, customModelCatalog: { ...settings.customModelCatalog, anthropic: fetched } };
    const options = getModelOptions("anthropic");
    assert.deepEqual(options, fetched);
    assert.equal(getModelDisplayName("anthropic", "claude-opus-5"), "Claude Opus 5 (fetched)");
  });

  await check("simulated 'Add custom model ID' appends onto the persisted list", () => {
    // This mirrors renderModelSection()'s Add-button handler: read the
    // current persisted (or fallback) list, append, write back.
    const existing = settings.customModelCatalog?.anthropic ?? [];
    const withCustom = [...existing, { value: "claude-custom-test", label: "claude-custom-test" }];
    settings = { ...settings, customModelCatalog: { ...settings.customModelCatalog, anthropic: withCustom } };
    const options = getModelOptions("anthropic");
    assert.ok(options.some((m) => m.value === "claude-custom-test"));
    assert.equal(options.length, 3);
  });

  await check("catalog survives a simulated saveData()/loadData() restart cycle", () => {
    // Before the fix: fetched/added models lived only in a module-level Map
    // and would be gone here because they were never part of `settings`.
    const restarted = simulateRestart(settings);
    // Simulate main.ts's loadSettings()/onload() re-registering the source
    // against the freshly-deserialized settings object, as happens on a
    // real Obsidian restart.
    settings = restarted;
    setSettingsSource(() => settings);

    const options = getModelOptions("anthropic");
    assert.equal(options.length, 3, "fetched + custom models must survive the restart, not just the bundled 3");
    assert.ok(options.some((m) => m.value === "claude-opus-5"), "fetched model must survive restart");
    assert.ok(options.some((m) => m.value === "claude-custom-test"), "custom-added model must survive restart");
  });

  await check("simulated delete removes only the targeted entry and getModelOptions reflects it immediately", () => {
    // Mirrors renderModelSection()'s per-row delete button.
    const remaining = (settings.customModelCatalog?.anthropic ?? []).filter((m) => m.value !== "claude-custom-test");
    settings = { ...settings, customModelCatalog: { ...settings.customModelCatalog, anthropic: remaining } };
    const options = getModelOptions("anthropic");
    assert.equal(options.length, 2);
    assert.ok(!options.some((m) => m.value === "claude-custom-test"));
    assert.ok(options.some((m) => m.value === "claude-opus-5"));
  });

  await check("a provider with no persisted catalog is unaffected by another provider's catalog", () => {
    const openaiModels = getModelOptions("openai");
    assert.ok(openaiModels.length > 0);
    assert.ok(!openaiModels.some((m) => m.value === "claude-opus-5"));
  });

  await check("deleting down to an empty persisted list degrades back to the bundled fallback (no dangling empty override)", () => {
    settings = { ...settings, customModelCatalog: { ...settings.customModelCatalog, anthropic: [] } };
    const options = getModelOptions("anthropic");
    assert.ok(options.length > 0, "must fall back to bundled defaults, not return an empty catalog");
    assert.ok(options.some((m) => m.value === "claude-sonnet-4-6"));
  });

  console.log(`\n${passed} checks passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
