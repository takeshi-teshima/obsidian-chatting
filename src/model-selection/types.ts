import type { Provider } from "../types";
import type { ReasoningEffort } from "../model/capabilities";

/**
 * Durable seed for a newly-created / still-pristine conversation. Claudian
 * parity: an explicit composer picker choice updates this; existing
 * conversations never subscribe to it (they already own
 * SessionMetadata.selectedModel from branch 13).
 */
export interface StoredChatModelSelection {
  providerId: Provider;
  model: string;
}

export interface ComposerModelOption {
  providerId: Provider;
  value: string;
  label: string;
  description?: string;
  /** Human-readable group heading; normally provider display name. */
  group?: string;
  /** Optional Obsidian/Lucide icon name supplied by host integration. */
  providerIcon?: string;
}

export interface ComposerReasoningOption {
  value: ReasoningEffort;
  label: string;
  description?: string;
}

export interface ComposerSelection {
  providerId: Provider;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelSelectionSettingsShape {
  /** Claudian-style seed. Existing conversations never subscribe to this value. */
  lastSelectedChatModel?: StoredChatModelSelection;
  /** Legacy runtime fields. Read once for migration; never use as turn authority afterward. */
  provider?: Provider;
  model?: string;
}
