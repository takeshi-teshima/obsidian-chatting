import type { App } from "obsidian";
import type { ChatSettings, UnifiedMessage } from "../types";
import { AgentLoop } from "./loop";
import type { SessionAgentAdapter, SessionAgentCallbacks } from "../session/runtime";
import type { SessionRunRequest } from "../session/types";
import { createProviderConversationState } from "../api/provider-session-state";

/**
 * Adapter around the existing AgentLoop so the session subsystem never
 * depends on AgentLoop's constructor shape or UI details directly.
 *
 * One instance is created per SessionRuntime (via SessionAgentFactory in
 * main.ts), and each instance owns exactly one AgentLoop and one
 * ProviderConversationState. Nothing here is module-global.
 */
export class AgentLoopSessionAdapter implements SessionAgentAdapter {
  private readonly loop: AgentLoop;

  constructor(app: App, settings: ChatSettings) {
    this.loop = new AgentLoop(app, settings, createProviderConversationState());
  }

  async run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void> {
    await this.loop.run(
      request.text,
      callbacks,
      request.selection ?? null,
      request.contextRefs ?? [],
    );
  }

  abort(): void {
    this.loop.abort();
  }

  exportMessages(): UnifiedMessage[] {
    return this.loop.exportMessages();
  }

  importMessages(messages: UnifiedMessage[]): void {
    this.loop.importMessages(messages);
  }

  resetProviderContinuation(): void {
    this.loop.resetProviderContinuation();
  }
}
