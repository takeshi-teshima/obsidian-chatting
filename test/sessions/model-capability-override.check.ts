// Regression check for a real report: selecting a custom model added via
// "Add custom model ID" (e.g. a hypothetical "gpt-6-astra") made the
// reasoning-effort selector disappear entirely, because
// src/model/capabilities.ts's name-based heuristic is deliberately
// conservative about model names it doesn't recognize yet.
//
// Fix: ModelCatalogEntry.reasoningOverride ("auto" | "on" | "off"), set from
// Settings -> "Manage models..." (per-row dropdown, or at add-time), lets a
// catalog entry force the reasoning selector to show/hide regardless of what
// the heuristic would have guessed. This exercises getModelCapabilities()
// directly against a live settingsSource, the same way
// model-catalog-persistence.check.ts exercises getModelOptions().
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, type ChatSettings } from "../../src/types";
import { setSettingsSource } from "../../src/model-catalog";
import { getModelCapabilities } from "../../src/model/capabilities";

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

function main(): void {
  console.log("== model capability override: reasoningOverride on a catalog entry ==");

  let settings: ChatSettings = { ...DEFAULT_SETTINGS };
  setSettingsSource(() => settings);

  check("an unrecognized model name (no catalog entry at all) is conservatively treated as no reasoning support", () => {
    const capabilities = getModelCapabilities("openai", "gpt-6-astra");
    assert.equal(capabilities.reasoning.supported, false);
    assert.deepEqual(capabilities.reasoning.efforts, []);
  });

  check("reasoningOverride: 'on' forces the selector on for an otherwise-unrecognized model", () => {
    settings = {
      ...settings,
      customModelCatalog: {
        openai: [{ value: "gpt-6-astra", label: "gpt-6-astra", reasoningOverride: "on" }],
      },
    };
    const capabilities = getModelCapabilities("openai", "gpt-6-astra");
    assert.equal(capabilities.reasoning.supported, true);
    assert.ok(capabilities.reasoning.efforts.length > 0);
  });

  check("reasoningOverride: 'off' forces the selector off even for a model the heuristic WOULD recognize", () => {
    settings = {
      ...settings,
      customModelCatalog: {
        anthropic: [{ value: "claude-opus-4-7", label: "Claude Opus 4.7", reasoningOverride: "off" }],
      },
    };
    // Sanity: without the override, this exact model IS heuristically reasoning-capable.
    const withoutOverride = getModelCapabilities("anthropic", "claude-sonnet-4-6");
    assert.equal(withoutOverride.reasoning.supported, true);

    const capabilities = getModelCapabilities("anthropic", "claude-opus-4-7");
    assert.equal(capabilities.reasoning.supported, false);
    assert.deepEqual(capabilities.reasoning.efforts, []);
  });

  check("reasoningOverride: 'auto' (or absent) defers entirely to the heuristic, unchanged", () => {
    settings = {
      ...settings,
      customModelCatalog: {
        anthropic: [{ value: "claude-opus-4-7", label: "Claude Opus 4.7", reasoningOverride: "auto" }],
      },
    };
    const capabilities = getModelCapabilities("anthropic", "claude-opus-4-7");
    assert.equal(capabilities.reasoning.supported, true);
  });

  check("a catalog entry for a DIFFERENT model doesn't affect this one's heuristic result", () => {
    settings = {
      ...settings,
      customModelCatalog: {
        openai: [{ value: "some-other-model", label: "Other", reasoningOverride: "on" }],
      },
    };
    const capabilities = getModelCapabilities("openai", "gpt-6-astra");
    assert.equal(capabilities.reasoning.supported, false, "must not pick up an unrelated entry's override");
  });

  console.log(`\n${passed} checks passed.`);
}

main();
