import type { Provider } from "../types";
import type { SessionMetadata } from "../sessions/metadata/types";
import { getChattingProviderState } from "../sessions/metadata/types";
import type { ReasoningEffort } from "../model/capabilities";
import type { TurnExecutionConfig } from "./types";

export interface TurnSelectionFallback {
  provider: Provider;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Resolves the configuration that would be admitted if Send were pressed right now. */
export function resolveNextTurnExecution(
  metadata: SessionMetadata,
  fallback: TurnSelectionFallback,
): TurnExecutionConfig {
  const state = getChattingProviderState(metadata);
  const provider = normalizeProvider(state.upstreamProvider) ?? fallback.provider;
  const model = metadata.selectedModel?.trim() || fallback.model.trim();
  if (!model) throw new Error("No model is selected for this conversation.");
  const reasoningEffort = normalizeReasoningEffort(state.reasoningEffort) ?? fallback.reasoningEffort;
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/**
 * Updates the session's *next-turn* selection without changing its logical
 * Chatting provider identity. Existing conversations may switch model and
 * reasoning effort, but not upstream provider through this control.
 *
 * `allowProviderSwitch` (added for branch 14's pristine-conversation rule;
 * defaults to false so branch 13 alone never allows a provider change here)
 * lets a still-empty (messageCount === 0) conversation pick any enabled
 * provider's model. Once the conversation is bound to a provider, the
 * cross-provider attempt is rejected with a recoverable error rather than
 * silently mutating the session's provider identity.
 */
export function applyNextTurnSelection(
  metadata: SessionMetadata,
  selection: TurnExecutionConfig,
  allowProviderSwitch = false,
): SessionMetadata {
  const state = getChattingProviderState(metadata);
  const existingProvider = normalizeProvider(state.upstreamProvider);
  if (existingProvider && existingProvider !== selection.provider && !allowProviderSwitch) {
    throw new Error(
      `This conversation uses ${existingProvider}; create or fork a conversation to switch provider.`,
    );
  }
  const model = selection.model.trim();
  if (!model) throw new Error("Model must not be empty.");
  return {
    ...metadata,
    selectedModel: model,
    providerState: {
      ...(metadata.providerState ?? {}),
      ...state,
      upstreamProvider: selection.provider,
      ...(selection.reasoningEffort
        ? { reasoningEffort: selection.reasoningEffort }
        : { reasoningEffort: undefined }),
    },
  };
}

export function sameTurnExecution(
  left: TurnExecutionConfig | null | undefined,
  right: TurnExecutionConfig | null | undefined,
): boolean {
  return !!left && !!right
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

export function normalizeProvider(value: unknown): Provider | null {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth"
    ? value
    : null;
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "max"
    ? value
    : undefined;
}
