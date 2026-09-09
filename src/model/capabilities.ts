import type { Provider } from "../types";
import { getModelOptions } from "../model-catalog";

export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "max";
export type ProviderReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCapabilities {
  reasoning: {
    supported: boolean;
    efforts: readonly ProviderReasoningEffort[];
  };
  input: {
    image: boolean;
    pdf: boolean;
  };
  webSearch: boolean;
}

const NONE: ModelCapabilities = {
  reasoning: { supported: false, efforts: [] },
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
    return { ...capabilities, reasoning: { supported: true, efforts: OVERRIDE_ON_EFFORTS[provider] } };
  }
  return { ...capabilities, reasoning: { supported: false, efforts: [] } };
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
    return {
      reasoning: {
        supported: isGpt5 || isO,
        efforts: isGpt5
          ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
          : isO
            ? ["low", "medium", "high"]
            : [],
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
