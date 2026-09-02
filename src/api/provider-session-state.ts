/**
 * Mutable provider conversation state must be owned by one SessionRuntime.
 * Never place these values in module-level variables once concurrent sessions exist.
 */
export interface ProviderConversationState {
  openai: {
    previousResponseId: string | null;
    /** First request after hydration/restart replays UnifiedMessage history. */
    requiresHistoryReplay: boolean;
  };
}

export function createProviderConversationState(): ProviderConversationState {
  return {
    openai: {
      previousResponseId: null,
      requiresHistoryReplay: true,
    },
  };
}

export function resetProviderConversationState(state: ProviderConversationState): void {
  state.openai.previousResponseId = null;
  state.openai.requiresHistoryReplay = true;
}
