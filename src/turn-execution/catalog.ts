import type { Provider } from "../types";
import { getModelCapabilities, type ReasoningEffort } from "../model/capabilities";
import { getModelOptions } from "../settings";
import type { TurnModelCatalog, TurnModelOption } from "./types";

const ALL_REASONING_EFFORTS: readonly ReasoningEffort[] = ["auto", "low", "medium", "high", "max"];

export interface ModelCatalogDependencies {
  /** Reuse settings.ts's provider model catalog; do not create a competing one. */
  getModels(provider: Provider): readonly TurnModelOption[];
  getReasoningEfforts(provider: Provider, model: string): readonly ReasoningEffort[];
}

/** Default dependency wiring: reuses the plugin's existing model catalog + capability resolver. */
export const defaultModelCatalogDependencies: ModelCatalogDependencies = {
  getModels: (provider) => getModelOptions(provider),
  getReasoningEfforts: (provider, model) => {
    const capabilities = getModelCapabilities(provider, model);
    return capabilities.reasoning.supported ? ALL_REASONING_EFFORTS : [];
  },
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
