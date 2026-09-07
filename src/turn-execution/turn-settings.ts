import type { ChatSettings } from "../types";
import type { TurnExecutionConfig } from "./types";

/**
 * Apply a captured turn selection to the session-local settings object owned
 * by one AgentLoop. NEVER pass plugin.settings itself to this function —
 * every SessionAgentFactory.create() call already clones settings per
 * session (see main.ts's buildAgentFactory), and this only ever mutates that
 * per-session clone through AgentLoop.updateSettings().
 */
export function applyTurnExecutionToSessionSettings(
  sessionSettings: ChatSettings,
  execution: TurnExecutionConfig,
): void {
  sessionSettings.provider = execution.provider;
  sessionSettings.model = execution.model;
  if (execution.reasoningEffort) {
    sessionSettings.reasoningEffort = execution.reasoningEffort;
  }
}

/** Defensive helper for AgentLoop factories. */
export function cloneSettingsForSession(settings: ChatSettings): ChatSettings {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(settings);
  }
  return JSON.parse(JSON.stringify(settings)) as ChatSettings;
}
