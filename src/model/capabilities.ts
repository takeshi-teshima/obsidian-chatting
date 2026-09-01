import type { Provider } from "../types";

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
 * Conservative capability resolver.
 * Unknown models deliberately get fewer capabilities rather than optimistic ones.
 * Keep all model-name heuristics here; provider adapters should consume this API.
 */
export function getModelCapabilities(provider: Provider, modelId: string): ModelCapabilities {
  const model = modelId.trim().toLowerCase();
  if (!model) return NONE;

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
