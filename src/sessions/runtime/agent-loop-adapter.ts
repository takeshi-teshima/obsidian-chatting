import type { SelectionScope, ToolResult, UnifiedMessage } from "../../types";
import type { SessionMetadata } from "../metadata/types";
import type { SessionRunRequest } from "./types";
import type { SessionAgentAdapter, SessionAgentCallbacks } from "./runtime";

/**
 * Structural contract for the branch-10 AgentLoop. The merge agent can adapt
 * exact names without making SessionRuntime import AgentLoop directly.
 */
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
  applySessionMetadata?: (metadata: SessionMetadata) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
}

export class AgentLoopSessionAdapter implements SessionAgentAdapter {
  constructor(
    private readonly agent: AgentLoopLike,
    private readonly hooks: AgentLoopSessionHooks,
  ) {}

  run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void> {
    return this.agent.run(request.text, callbacks, request.selection ?? null, request.contextRefs);
  }
  abort(): void { this.agent.abort(); }
  exportMessages(): UnifiedMessage[] { return this.agent.exportMessages(); }
  importMessages(messages: UnifiedMessage[]): void { this.agent.importMessages(messages); }
  resetProviderContinuation(): void { this.hooks.resetProviderContinuation(); }
  applySessionMetadata(metadata: SessionMetadata): void | Promise<void> { return this.hooks.applySessionMetadata?.(metadata); }
  dispose(): void | Promise<void> { return this.hooks.dispose?.(); }
}
