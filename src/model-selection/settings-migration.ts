import type { ModelSelectionSettingsShape, StoredChatModelSelection } from "./types";

export interface LegacySelectionMigrationResult<T extends ModelSelectionSettingsShape> {
  settings: T;
  migrated: boolean;
  seed?: StoredChatModelSelection;
}

/**
 * One-way semantic migration. Legacy `provider` + `model` are copied to the
 * Claudian-style `lastSelectedChatModel` only when no newer seed exists.
 * The legacy keys are intentionally not deleted here so rollback remains safe
 * — but after this branch, no runtime/provider adapter reads them as
 * execution authority; see turn-execution/selection.ts and
 * SessionManager.setNextTurnSelection().
 */
export function migrateLegacyModelSelection<T extends ModelSelectionSettingsShape>(
  source: T,
): LegacySelectionMigrationResult<T> {
  if (isStoredSelection(source.lastSelectedChatModel)) {
    return { settings: source, migrated: false, seed: source.lastSelectedChatModel };
  }
  const providerId = normalizeProvider(source.provider);
  const model = typeof source.model === "string" ? source.model.trim() : "";
  if (!providerId || !model) return { settings: source, migrated: false };

  const seed: StoredChatModelSelection = { providerId, model };
  return {
    settings: { ...source, lastSelectedChatModel: seed },
    migrated: true,
    seed,
  };
}

export function readModelSelectionSeed(
  settings: ModelSelectionSettingsShape,
): StoredChatModelSelection | null {
  return isStoredSelection(settings.lastSelectedChatModel)
    ? { ...settings.lastSelectedChatModel }
    : null;
}

function isStoredSelection(value: unknown): value is StoredChatModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return !!normalizeProvider(candidate.providerId)
    && typeof candidate.model === "string"
    && candidate.model.trim().length > 0;
}

function normalizeProvider(value: unknown): StoredChatModelSelection["providerId"] | null {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth"
    ? value
    : null;
}
