import type { SelectionScope, ToolResult, UnifiedMessage } from "../../types";
import type { SessionMetadata } from "../metadata/types";
import type { SessionRunRequest } from "./types";
import type { TurnExecutionConfig } from "../../turn-execution/types";
import { stampLatestCanonicalUserMessage } from "../../turn-execution/provenance";
import type { SessionAgentAdapter, SessionAgentCallbacks } from "./runtime";

/** Structural contract for AgentLoop, kept here so SessionRuntime never imports AgentLoop directly. */
export interface AgentLoopLike {
  run(
    text: string,
    callbacks: {
      onThinking: () => void;
      onToolCall: (name: string, input: Record<string, unknown>) => void;
      onToolResult: (name: string, result: ToolResult) => void;
      onResponse: (text: string) => void;
      onAskUser: (question: string) => Promise<string>;
      onError: (message: string) => void;
    },
    selection?: SelectionScope | null,
    contextRefs?: SessionRunRequest["contextRefs"],
  ): Promise<void>;
  abort(): void;
  exportMessages(): UnifiedMessage[];
  importMessages(messages: UnifiedMessage[]): void;
  clear?(): void;
}

export interface AgentLoopSessionHooks {
  resetProviderContinuation: () => void;
  /**
   * Apply the admitted turn's immutable config to this AgentLoop's
   * session-local settings clone, just before AgentLoop.run() is invoked.
   * Must never touch plugin-global settings.
   */
  applyTurnExecution?: (execution: TurnExecutionConfig) => void | Promise<void>;
  /** Prepare this session's provider continuation state; e.g. OpenAI clears previous_response_id on a model change. */
  prepareProviderContinuation?: (provider: string, model: string) => void;
  /** Optional hook when selectedModel/providerState changes while idle (non-turn-scoped configuration). */
  applySessionMetadata?: (metadata: SessionMetadata) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export class AgentLoopSessionAdapter implements SessionAgentAdapter {
  constructor(
    private readonly agent: AgentLoopLike,
    private readonly hooks: AgentLoopSessionHooks,
  ) {}

  async run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void> {
    // Freeze this turn's provider/model/reasoning into the session-local
    // AgentLoop settings clone BEFORE the tool loop starts. AgentLoop.run()
    // snapshots its own `requestSettings` once at the top of the call and
    // uses that snapshot for every iteration, so a later setNextTurnSelection()
    // call (which only ever touches session *metadata*, never this AgentLoop's
    // settings) cannot affect this turn once it has started.
    await this.hooks.applyTurnExecution?.(request.execution);
    this.hooks.prepareProviderContinuation?.(request.execution.provider, request.execution.model);

    let stamped = false;
    const stamp = () => {
      if (stamped) return;
      stamped = stampLatestCanonicalUserMessage(this.agent.exportMessages(), request.execution);
    };
    const wrapped: SessionAgentCallbacks = {
      ...callbacks,
      onThinking: () => { stamp(); callbacks.onThinking(); },
      onToolCall: (name, input) => { stamp(); callbacks.onToolCall(name, input); },
      onToolResult: (name, result) => { stamp(); callbacks.onToolResult(name, result); },
      onResponse: (text) => { stamp(); callbacks.onResponse(text); },
      onAskUser: async (question) => { stamp(); return callbacks.onAskUser(question); },
      onError: (message) => { stamp(); callbacks.onError(message); },
    };
    try {
      await this.agent.run(request.text, wrapped, request.selection ?? null, request.contextRefs);
    } finally {
      stamp();
    }
  }
  abort(): void { this.agent.abort(); }
  exportMessages(): UnifiedMessage[] { return this.agent.exportMessages(); }
  importMessages(messages: UnifiedMessage[]): void { this.agent.importMessages(messages); }
  resetProviderContinuation(): void { this.hooks.resetProviderContinuation(); }
  applySessionMetadata(metadata: SessionMetadata): void | Promise<void> { return this.hooks.applySessionMetadata?.(metadata); }
  dispose(): void | Promise<void> { return this.hooks.dispose?.(); }
}
