import type { Provider } from "../types";
import {
  getModelCapabilities,
  supportsReasoningEffort,
  supportsUiReasoningEffort,
  type ProviderReasoningEffort,
  type ReasoningEffort,
} from "./capabilities";

export { type ReasoningEffort } from "./capabilities";

export interface ReasoningConfig {
  enabled: boolean;
  effort?: ProviderReasoningEffort;
}

/**
 * Fallback UI effort used whenever `requested` is not currently offered for this
 * model (see `ModelCapabilities.reasoning.uiEfforts`). In practice this only fires
 * for legacy persisted state: a `reasoningEffort: "auto"` seed/session value from
 * before capability-driven UI, now pointed at a provider/model that never had (or
 * lost) a real adaptive-reasoning backend mode. Chosen to match this fork's
 * long-standing effective behavior for those providers rather than surprise anyone.
 */
const FALLBACK_UI_EFFORT: ReasoningEffort = "medium";

/**
 * Normalize the UI's compact effort vocabulary into a provider/model-supported value.
 * Which UI values are meaningful for a given provider/model — including whether
 * "auto" means anything at all — is entirely decided by `getModelCapabilities()`
 * (`reasoning.uiEfforts`); this function does not special-case any provider itself.
 */
export function resolveReasoningConfig(
  provider: Provider,
  model: string,
  requested: ReasoningEffort,
): ReasoningConfig {
  const capabilities = getModelCapabilities(provider, model);
  if (!capabilities.reasoning.supported) return { enabled: false };

  const effective = supportsUiReasoningEffort(capabilities, requested) ? requested : FALLBACK_UI_EFFORT;

  if (effective === "auto") {
    // Only reachable when capabilities declared "auto" as a valid uiEffort for this
    // model, i.e. the provider genuinely has an adaptive/automatic backend mode —
    // let it run with no explicit effort rather than picking one on its behalf.
    return { enabled: true };
  }

  const candidates: ProviderReasoningEffort[] =
    effective === "max"
      ? ["max", "xhigh", "high", "medium"]
      : effective === "high"
        ? ["high", "xhigh", "medium"]
        : effective === "medium"
          ? ["medium", "high", "low"]
          : ["low", "minimal", "medium"];

  const effort = candidates.find((candidate) =>
    supportsReasoningEffort(capabilities, candidate),
  );
  return effort ? { enabled: true, effort } : { enabled: true };
}
