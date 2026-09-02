// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "chatgpt-oauth";

export type { ReasoningEffort } from "./model/capabilities";
import type { ReasoningEffort } from "./model/capabilities";
import type { ContextRef } from "./context/refs";

export interface ChatSettings {
  provider: Provider;
  /** API key for `anthropic` and `openai`. Empty for `chatgpt-oauth` (which uses SecretStorage credentials). */
  apiKey: string;
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  reasoningEffort: ReasoningEffort;
  customInstructions: string;
  /** Id of the selected default Prompt Profile (Markdown file under AI/Prompts). Null = no profile / global defaults. */
  activeProfileId: string | null;

  // ─── Session Workspaces ─────────────────────────────────────────────
  /** Max sessions allowed to run a turn concurrently. Desktop default 3, mobile default 2. Range 1-6. */
  maxConcurrentSessions: number;
  /** Max hydrated SessionRuntimes retained in memory (idle-LRU evicted beyond this). Default 8, range 2-24. */
  maxHydratedSessions: number;
  /** Show an in-app Notice when a non-visible session finishes/errors. */
  notifyBackgroundSessionCompletion: boolean;
  /** Remember whether the session browser rail is pinned open on wide desktop panes. */
  sessionManagerPinnedOnWideViews: boolean;
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
  maxConcurrentSessions: 3,
  maxHydratedSessions: 8,
  notifyBackgroundSessionCompletion: true,
  sessionManagerPinnedOnWideViews: false,
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
