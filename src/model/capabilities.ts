import type { Provider } from "../types";
import { getModelOptions } from "../model-catalog";

export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max";
export type ProviderReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCapabilities {
  reasoning: {
    supported: boolean;
    /** Backend-vocabulary effort values this model's API actually accepts (used by resolveReasoningConfig). */
    efforts: readonly ProviderReasoningEffort[];
    /**
     * UI-vocabulary effort values selectable for this model in the composer/settings
     * dropdowns. This is the single source of truth for whether "auto" is offered:
     * it's included only for providers whose backend has a genuine adaptive/automatic
     * reasoning mode (see `PROVIDERS_WITH_ADAPTIVE_REASONING` below), never as a
     * per-call-site special case. Callers must read this list rather than hardcode
     * `["auto", ...]` themselves.
     */
    uiEfforts: readonly ReasoningEffort[];
  };
  input: {
    image: boolean;
    pdf: boolean;
  };
  webSearch: boolean;
}

/**
 * Providers whose backend has a genuine adaptive/auto reasoning mode — i.e.
 * requesting "auto" makes the backend itself decide how much to reason,
 * rather than the client silently substituting a fixed effort value on its
 * behalf. Only these providers expose "auto" as a selectable option in
 * `uiEfforts`; adding a new provider with real adaptive support later means
 * adding it here, not adding an if-branch at each UI/resolver call site.
 */
const PROVIDERS_WITH_ADAPTIVE_REASONING: ReadonlySet<Provider> = new Set<Provider>(["anthropic"]);

/** Fixed, non-"auto" UI effort granularity offered whenever reasoning is supported. */
const BASE_UI_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

function deriveUiEfforts(provider: Provider, supported: boolean): readonly ReasoningEffort[] {
  if (!supported) return [];
  return PROVIDERS_WITH_ADAPTIVE_REASONING.has(provider) ? ["auto", ...BASE_UI_EFFORTS] : BASE_UI_EFFORTS;
}

/** Public helper for UI surfaces (e.g. the Settings tab's default-effort seed picker) that need
 * a provider's selectable effort list before a specific model is known/relevant. */
export function getReasoningEffortOptions(provider: Provider): readonly ReasoningEffort[] {
  return deriveUiEfforts(provider, true);
}

const NONE: ModelCapabilities = {
  reasoning: { supported: false, efforts: [], uiEfforts: [] },
  input: { image: false, pdf: false },
  webSearch: false,
};

/**
 * Default reasoning-effort list used when a catalog entry's
 * `reasoningOverride` forces reasoning ON for a model the name-based
 * heuristic below wouldn't otherwise have recognized — e.g. a future model
 * family ("gpt-6-astra") this codebase's regexes predate. Deliberately the
 * richest list per provider (a plausible superset for a newer/flagship
 * model); if the actual provider API rejects a value this doesn't support,
 * that's a normal API error, not a UI bug.
 */
const OVERRIDE_ON_EFFORTS: Record<Provider, readonly ProviderReasoningEffort[]> = {
  anthropic: ["low", "medium", "high"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  "chatgpt-oauth": ["low", "medium", "high", "xhigh"],
};

/**
 * Applies a catalog entry's manual `reasoningOverride` (Settings → "Manage
 * models…") on top of the name-based heuristic result. `"auto"`/absent
 * leaves the heuristic's answer untouched.
 */
function applyReasoningOverride(
  provider: Provider,
  modelId: string,
  capabilities: ModelCapabilities,
): ModelCapabilities {
  const entry = getModelOptions(provider).find((m) => m.value === modelId);
  const override = entry?.reasoningOverride;
  if (!override || override === "auto") return capabilities;
  if (override === "on") {
    return {
      ...capabilities,
      reasoning: {
        supported: true,
        efforts: OVERRIDE_ON_EFFORTS[provider],
        uiEfforts: deriveUiEfforts(provider, true),
      },
    };
  }
  return { ...capabilities, reasoning: { supported: false, efforts: [], uiEfforts: [] } };
}

/**
 * Conservative capability resolver.
 * Unknown models deliberately get fewer capabilities rather than optimistic ones
 * UNLESS a catalog entry explicitly overrides reasoning support (see
 * `applyReasoningOverride()` above) — e.g. for a model name this codebase's
 * heuristics don't recognize yet.
 * Keep all model-name heuristics here; provider adapters should consume this API.
 */
export function getModelCapabilities(provider: Provider, modelId: string): ModelCapabilities {
  const base = computeHeuristicCapabilities(provider, modelId);
  if (!base) return NONE;
  return applyReasoningOverride(provider, modelId, base);
}

function computeHeuristicCapabilities(provider: Provider, modelId: string): ModelCapabilities | null {
  const model = modelId.trim().toLowerCase();
  if (!model) return null;

  if (provider === "anthropic") {
    const isClaude = model.startsWith("claude-");
    const isReasoning = /claude-(sonnet|opus)-(3-7|4|4-|4\.)/.test(model);
    return {
      reasoning: {
        supported: isReasoning,
        efforts: isReasoning ? ["low", "medium", "high"] : [],
        uiEfforts: deriveUiEfforts(provider, isReasoning),
      },
      input: {
        image: isClaude,
        pdf: isClaude,
      },
      webSearch: isClaude,
    };
  }

  if (provider === "openai") {
    const isGpt5 = /^gpt-5(?:\.|-|$)/.test(model);
    const isO = /^o\d/.test(model);
    const isVision = isGpt5 || /^gpt-4o(?:-|$)/.test(model);
    const supportsReasoning = isGpt5 || isO;
    return {
      reasoning: {
        supported: supportsReasoning,
        efforts: isGpt5
          ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
          : isO
            ? ["low", "medium", "high"]
            : [],
        uiEfforts: deriveUiEfforts(provider, supportsReasoning),
      },
      input: {
        image: isVision,
        pdf: false,
      },
      webSearch: true,
    };
  }

  // ChatGPT OAuth uses the Codex Responses-style backend. Be conservative:
  // current supported gpt-5/codex slugs reason and accept images, but native PDF
  // upload is intentionally not part of this fork's PDF design.
  const isCodex = /codex/.test(model) || /^gpt-5(?:\.|-|$)/.test(model);
  return {
    reasoning: {
      supported: isCodex,
      efforts: isCodex ? ["low", "medium", "high", "xhigh"] : [],
      uiEfforts: deriveUiEfforts(provider, isCodex),
    },
    input: {
      image: isCodex,
      pdf: false,
    },
    webSearch: isCodex,
  };
}

export function supportsReasoningEffort(
  capabilities: ModelCapabilities,
  effort: ProviderReasoningEffort,
): boolean {
  return capabilities.reasoning.efforts.includes(effort);
}

/** Whether `effort` (UI vocabulary, e.g. "auto") is currently offered for this model. */
export function supportsUiReasoningEffort(
  capabilities: ModelCapabilities,
  effort: ReasoningEffort,
): boolean {
  return capabilities.reasoning.uiEfforts.includes(effort);
}
