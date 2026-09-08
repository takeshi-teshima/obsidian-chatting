// Model catalog: bundled fallback lists + the persisted per-provider
// overrides a user builds up via Settings → "Model catalog" (fetch from the
// provider's API, or add a custom model ID). Deliberately has NO import from
// "obsidian" — src/settings.ts (which does depend on Obsidian for its
// `requestUrl`-based fetch helpers and its `PluginSettingTab` UI) delegates
// to this module, and so does the plain-Node regression check
// (test/sessions/model-catalog-persistence.check.ts) that exercises the
// restart-survival bug this replaces the old in-memory `modelCache` Map to
// fix.
import type ChatPlugin from "./main";
import type { Provider, ChatSettings, ModelCatalogEntry } from "./types";

export type ModelOption = ModelCatalogEntry;

export const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-5.3-codex", label: "Codex 5.3" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  // Mirrors the bundled `models.json` shipped with the official OpenAI Codex
  // CLI. These are the slugs the Codex backend currently accepts when the
  // request is authenticated with a ChatGPT account. Sorted by Codex CLI
  // priority (lowest first = default — see the "Default" badge in Settings
  // → "Manage models…", which reflects LIST POSITION, not a hardcoded
  // label; reordering the list in that UI changes the actual default).
  // Update when upstream changes.
  "chatgpt-oauth": [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
    { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
    { value: "gpt-5.2", label: "GPT-5.2" },
  ],
};

/**
 * Live reference to the plugin's own persisted settings, so module-level
 * functions (`getModelOptions`/`getModelDisplayName`) called from
 * src/main.ts, src/ui/chat-view.ts and src/turn-execution/catalog.ts can
 * read the persisted model catalog without every call site having to be
 * changed to thread a `ChatSettings`/plugin argument through.
 *
 * Set once from `ChatPlugin.onload()` (after `loadSettings()`) via
 * `setSettingsSource`. Because it's a getter (not a captured object), it
 * always sees the current `plugin.settings` even across the reassignment
 * that happens inside `loadSettings()`.
 */
let settingsSource: (() => ChatSettings) | null = null;

/** Registers the live settings getter. Call once from ChatPlugin.onload(). */
export function setSettingsSource(getSettings: () => ChatSettings): void {
  settingsSource = getSettings;
}

function readCustomCatalog(provider: string): ModelOption[] | undefined {
  const settings = settingsSource?.();
  const entry = settings?.customModelCatalog?.[provider as Provider];
  return entry && entry.length > 0 ? entry : undefined;
}

/** Persists a provider's full model list into `ChatSettings.customModelCatalog` and saves. */
export async function writeCustomCatalog(plugin: ChatPlugin, provider: string, models: ModelOption[]): Promise<void> {
  const existing = plugin.settings.customModelCatalog ?? {};
  plugin.settings.customModelCatalog = { ...existing, [provider as Provider]: models };
  await plugin.saveSettings();
}

/** Resolve a model ID to its display name */
export function getModelDisplayName(provider: string, modelId: string): string {
  const models = getModelOptions(provider);
  const match = models.find((m) => m.value === modelId);
  return match?.label || modelId;
}

/**
 * Current known model list for a provider: the persisted catalog (fetched
 * from the provider's API and/or custom-added, written to
 * `ChatSettings.customModelCatalog` so it survives restarts and syncs
 * across devices via `data.json`) if present, else the bundled fallback
 * list. Reused by the turn-level model selector
 * (src/turn-execution/catalog.ts) so there is exactly one catalog, not a
 * competing one.
 */
export function getModelOptions(provider: string): ModelOption[] {
  return readCustomCatalog(provider) || FALLBACK_MODELS[provider] || [];
}
