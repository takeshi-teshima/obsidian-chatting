import type { Provider } from "../types";
import { getModelCapabilities, type ReasoningEffort } from "../model/capabilities";
import { getModelOptions } from "../settings";
import type { TurnModelCatalog, TurnModelOption } from "./types";

export interface ModelCatalogDependencies {
  /** Reuse settings.ts's provider model catalog; do not create a competing one. */
  getModels(provider: Provider): readonly TurnModelOption[];
  getReasoningEfforts(provider: Provider, model: string): readonly ReasoningEffort[];
}

/**
 * Default dependency wiring: reuses the plugin's existing model catalog + capability
 * resolver. Which effort values (including whether "auto" is one of them) are offered
 * is entirely delegated to `ModelCapabilities.reasoning.uiEfforts` — no provider
 * special-casing here, matching src/ui/chat-view.ts's composerCatalogHost().
 */
export const defaultModelCatalogDependencies: ModelCatalogDependencies = {
  getModels: (provider) => getModelOptions(provider),
  getReasoningEfforts: (provider, model) => getModelCapabilities(provider, model).reasoning.uiEfforts,
};

export function buildTurnModelCatalog(
  provider: Provider,
  selectedModel: string,
  dependencies: ModelCatalogDependencies = defaultModelCatalogDependencies,
): TurnModelCatalog {
  return {
    provider,
    models: [...dependencies.getModels(provider)],
    reasoningEfforts: [...dependencies.getReasoningEfforts(provider, selectedModel)],
  };
}
