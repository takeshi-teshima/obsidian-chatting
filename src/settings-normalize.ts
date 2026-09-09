// Pure, Obsidian-free settings sanitization — deliberately has NO import
// from "obsidian" (same rationale as src/model-catalog.ts) so it, and the
// data-durability guarantee it provides, can be exercised by a plain-Node
// regression check (test/sessions/settings-round-trip.check.ts) without
// pulling in Obsidian runtime stubs.
import type { ChatSettings } from "./types";

/**
 * Sanitizes `data.json` before merging it under `DEFAULT_SETTINGS` in
 * `ChatPlugin.loadSettings()`.
 *
 * IMPORTANT — this used to be a strict allowlist that only copied over a
 * fixed set of fields (`provider`/`apiKey`/`model`/`maxIterations`/
 * `enableWebSearch`/`reasoningEffort`/`customInstructions`/
 * `activeProfileId`), silently DROPPING everything else. Every settings
 * field added since then (`lastSelectedChatModel`, `customModelCatalog`,
 * `sendOnEnter`, `titleGenerationEnabled`, `titleGeneration`, and whatever
 * comes next) was never added to that list, so it got wiped from memory on
 * every plugin reload (`app:reload`, an Obsidian restart, or toggling the
 * plugin off/on) — the file on disk still had the right value until the
 * NEXT `saveSettings()` call (e.g. toggling an unrelated setting), which
 * would then overwrite it with the now-stripped in-memory value. This is
 * exactly the bug behind a real report: a user's customized model catalog
 * order/entries appeared to "disappear" after routine reloads.
 *
 * Fixed by starting from the ENTIRE persisted object (it's already shaped
 * like `Partial<ChatSettings>` since we wrote it ourselves via
 * `saveSettings()`) and only re-validating/clearing the handful of fields
 * that actually need defensive type-narrowing against a corrupt or
 * pre-migration `data.json`. Any newly-added settings field is preserved by
 * default without needing this function to be updated — see
 * `test/sessions/settings-round-trip.check.ts` for the regression test that
 * guards this.
 */
export function normalizeSettings(value: unknown): Partial<ChatSettings> {
  if (!isRecord(value)) return {};
  const settings: Partial<ChatSettings> = { ...(value as Partial<ChatSettings>) };
  if (!isProvider(value.provider)) delete settings.provider;
  if (typeof value.apiKey !== "string") delete settings.apiKey;
  if (typeof value.model !== "string") delete settings.model;
  if (typeof value.maxIterations !== "number") delete settings.maxIterations;
  if (typeof value.enableWebSearch !== "boolean") delete settings.enableWebSearch;
  if (!isReasoningEffort(value.reasoningEffort)) delete settings.reasoningEffort;
  if (typeof value.customInstructions !== "string") delete settings.customInstructions;
  if (typeof value.activeProfileId === "string" && value.activeProfileId.trim()) {
    settings.activeProfileId = value.activeProfileId;
  } else {
    settings.activeProfileId = null;
  }
  return settings;
}

export function isProvider(value: unknown): value is ChatSettings["provider"] {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth";
}

export function isReasoningEffort(value: unknown): value is ChatSettings["reasoningEffort"] {
  return (
    value === "auto" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
