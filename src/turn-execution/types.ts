import type { Provider } from "../types";
import type { ReasoningEffort } from "../model/capabilities";

/**
 * Immutable execution choice captured when the user presses Send.
 * Provider is included for routing safety, but for an existing session the
 * selector must not change providers; it is derived from session metadata
 * (see turn-execution/selection.ts's `applyNextTurnSelection`, which rejects
 * cross-provider changes for an already-bound conversation).
 */
export interface TurnExecutionConfig {
  provider: Provider;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

/** Lightweight option used by the per-turn selector UI. */
export interface TurnModelOption {
  value: string;
  label: string;
  description?: string;
}

export interface TurnModelCatalog {
  provider: Provider;
  models: TurnModelOption[];
  reasoningEfforts: ReasoningEffort[];
}

/**
 * Provider-native provenance persisted on the canonical user message.
 * This does not change Claudian SessionMetadata; it belongs to Chatting's
 * provider-native UnifiedMessage JSONL history.
 */
export interface TurnExecutionProvenance {
  schemaVersion: 1;
  provider: Provider;
  model: string;
  reasoningEffort?: ReasoningEffort;
}
