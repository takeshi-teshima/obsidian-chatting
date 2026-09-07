// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "chatgpt-oauth";

export type { ReasoningEffort } from "./model/capabilities";
import type { ReasoningEffort } from "./model/capabilities";
import type { ContextRef } from "./context/refs";
import type { TurnExecutionProvenance } from "./turn-execution/types";
import type { StoredChatModelSelection } from "./model-selection/types";

export interface ChatSettings {
  /**
   * @deprecated Legacy execution-authority fields (Settings Workspaces v4.3,
   * branch 14). Read at most ONCE, during startup migration, to seed
   * `lastSelectedChatModel` when no seed exists yet — see
   * src/model-selection/settings-migration.ts and main.ts's loadSettings().
   * No runtime/provider adapter may use `provider`/`model` here as turn
   * execution authority; that is now `SessionMetadata.selectedModel` /
   * `providerState.upstreamProvider` (next-turn) frozen into a
   * `TurnExecutionConfig` at Send (this-turn). Kept present (not deleted)
   * only so rollback to a pre-v4.3 build stays safe.
   */
  provider: Provider;
  /** API key for `anthropic` and `openai`. Empty for `chatgpt-oauth` (which uses SecretStorage credentials). */
  apiKey: string;
  /** @deprecated see the `provider` field's doc comment above. */
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  /** Default reasoning effort seed for new sessions; not execution authority for an existing session's turns. */
  reasoningEffort: ReasoningEffort;
  customInstructions: string;
  /** Id of the selected default Prompt Profile (Markdown file under AI/Prompts). Null = no profile / global defaults. */
  activeProfileId: string | null;
  /**
   * Claudian-style durable seed for a FUTURE pristine (messageCount === 0)
   * conversation's provider+model. An explicit composer picker choice
   * updates this (see model-selection/seed-coordinator.ts); existing
   * conversations never subscribe to it. Absent until first migrated/set.
   */
  lastSelectedChatModel?: StoredChatModelSelection;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-6",
  maxIterations: 20,
  enableWebSearch: true,
  reasoningEffort: "auto",
  customInstructions: "",
  activeProfileId: null,
};

/**
 * Default model for the ChatGPT OAuth provider.
 *
 * Mirrors the priority-0 entry in the official Codex CLI's bundled
 * `models.json`. The Codex backend rejects models that aren't on this short
 * approved list (the error message shape is `"The 'X' model is not supported
 * when using Codex with a ChatGPT account."`), so we deliberately don't
 * default to anything outside it.
 */
export const CHATGPT_OAUTH_DEFAULT_MODEL = "gpt-5.5";

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /**
   * JSON-safe metadata references to vault assets (images, PDFs) attached to
   * this message. Never contains file bytes/base64 — see `ContextRef`.
   * Provider adapters resolve these to provider-native content at request
   * time via `src/api/vision.ts`; nothing binary is ever persisted here.
   */
  contextRefs?: ContextRef[];
  /**
   * Provider-native turn-execution provenance (branch 13: turn-level model
   * selection). Only ever set on canonical user turn-starters (string
   * content), never on tool-result "user" messages. Absent on messages
   * created before this branch and on any message this branch doesn't stamp
   * — never retroactively synthesized. See src/turn-execution/provenance.ts.
   */
  execution?: TurnExecutionProvenance;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface UnifiedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── API Response ───────────────────────────────────────────────────────────

export interface UnifiedResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop";
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  activeFileContent: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking: () => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
}
