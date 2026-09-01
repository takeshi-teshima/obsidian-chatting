import type { Provider } from "../types";
import {
  getModelCapabilities,
  supportsReasoningEffort,
  type ProviderReasoningEffort,
  type ReasoningEffort,
} from "./capabilities";

export { type ReasoningEffort } from "./capabilities";

export interface ReasoningConfig {
  enabled: boolean;
  effort?: ProviderReasoningEffort;
}

/**
 * Normalize the UI's compact effort vocabulary into a provider/model-supported value.
 * `auto` preserves the historical plugin behavior: medium for reasoning-capable OpenAI/Codex,
 * and provider adaptive/default behavior for Anthropic.
 */
export function resolveReasoningConfig(
  provider: Provider,
  model: string,
  requested: ReasoningEffort,
): ReasoningConfig {
  const capabilities = getModelCapabilities(provider, model);
  if (!capabilities.reasoning.supported) return { enabled: false };

  if (requested === "auto") {
    if (provider === "anthropic") return { enabled: true };
    return { enabled: true, effort: "medium" };
  }

  const candidates: ProviderReasoningEffort[] =
    requested === "max"
      ? ["max", "xhigh", "high", "medium"]
      : requested === "high"
        ? ["high", "xhigh", "medium"]
        : requested === "medium"
          ? ["medium", "high", "low"]
          : ["low", "minimal", "medium"];

  const effort = candidates.find((candidate) =>
    supportsReasoningEffort(capabilities, candidate),
  );
  return effort ? { enabled: true, effort } : { enabled: true };
}
