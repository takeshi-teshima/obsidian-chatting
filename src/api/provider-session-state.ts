/**
 * Conversation-local provider continuation state (e.g. OpenAI Responses API's
 * `previous_response_id`). One instance belongs to exactly one AgentLoop /
 * SessionRuntime — never store one of these in a module-global singleton.
 *
 * Prior to Session Workspaces v4.1-complete this lived as a module-level
 * `let previousResponseId` in api/openai.ts, which corrupted cross-session
 * conversation continuity as soon as two sessions ran concurrently (session
 * B's turn would silently chain off session A's response id, or vice versa).
 */
export class ProviderConversationState {
  previousResponseId: string | null = null;
  modelKey: string | null = null;
  providerKey: string | null = null;

  /** Clears continuation when the provider/model identity changes underneath it. */
  prepare(providerKey: string, modelKey: string): void {
    if (this.providerKey !== providerKey || this.modelKey !== modelKey) {
      this.previousResponseId = null;
      this.providerKey = providerKey;
      this.modelKey = modelKey;
    }
  }

  clearContinuation(): void {
    this.previousResponseId = null;
  }

  reset(): void {
    this.previousResponseId = null;
    this.modelKey = null;
    this.providerKey = null;
  }
}
