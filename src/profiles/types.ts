import type { ReasoningEffort } from "../model/reasoning";

export interface PromptProfileMetadata {
  id: string;
  name: string;
  description: string;
  source: "vault";
}

export interface PromptProfile extends PromptProfileMetadata {
  /** Optional provider model override. Empty/undefined means inherit global setting. */
  model?: string;
  /** Optional normalized effort override. */
  effort?: ReasoningEffort;
  /** Optional web-search override. */
  webSearch?: boolean;
  /** Optional skill allow-list. Undefined means normal global Skills behavior. */
  skills?: string[];
  /** Markdown body appended through prompt-composer's profileInstructions layer. */
  instructions: string;
}

export interface EffectiveProfileSettings {
  model: string;
  effort: ReasoningEffort;
  enableWebSearch: boolean;
  profileInstructions?: string;
  skillAllowlist?: string[];
}
