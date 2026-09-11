import { App } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
} from "../types";
import { sendMessage } from "../api/client";
import { clearChatGPTOAuthState } from "../api/chatgpt-oauth";
import { ProviderConversationState } from "../api/provider-session-state";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { sanitizeToolCallPairing } from "./tool-call-pairing";
import { SkillService, parseExplicitSkillInvocation } from "../skills/service";
import { PromptProfileService } from "../profiles/service";
import type { ContextRef } from "../context/refs";
import { VaultImageResolver } from "../context/image-resolver";

const MAX_CONVERSATION_LENGTH = 50;
const KEEP_RECENT = 40;

// Debug logging: writes transcript to the vault's plugin config folder
const DEBUG = true;

function debugLog(app: App, label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write into the current vault config folder.
    void app.vault.adapter.append(
      `${app.vault.configDir}/plugins/chatting-with-ai/debug.log`,
      entry
    );
  } catch {
    // Debug logging should never break the app
  }
}

/**
 * The core agentic loop:
 * 1. Send user message + history to API
 * 2. If response contains tool_use, execute tools, append results, loop
 * 3. If response is end_turn, deliver text to user, done
 * 4. Safety: stop after maxIterations to prevent runaway loops
 */
export class AgentLoop {
  private messages: UnifiedMessage[] = [];
  private app: App;
  private settings: ChatSettings;
  private aborted = false;
  private skills: SkillService;
  private profiles: PromptProfileService;
  private readonly imageResolver: VaultImageResolver;
  /**
   * Session-local Responses API continuation state (e.g. OpenAI's
   * `previous_response_id`). One instance per AgentLoop instance — never
   * shared across sessions — so concurrent multi-session turns never chain
   * off each other's response ids. See api/provider-session-state.ts.
   */
  private readonly providerConversation = new ProviderConversationState();

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
    this.skills = new SkillService(app);
    this.profiles = new PromptProfileService(app);
    this.imageResolver = new VaultImageResolver(app);
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Applies a partial settings patch to this loop instance only (e.g. when a
   * session's selectedModel/profile/reasoningEffort changes while idle).
   * Never mutates the plugin-global settings object this loop was
   * constructed with a shallow copy of.
   */
  updateSettings(patch: Partial<ChatSettings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  /** Current effective settings for this session's loop (read-only snapshot). */
  getSettings(): ChatSettings {
    return { ...this.settings };
  }

  /**
   * Prepare this session's provider continuation state for an about-to-start
   * turn's admitted provider/model. Delegates to
   * ProviderConversationState.prepare(), which clears `previousResponseId`
   * only when the provider/model identity actually changed since the last
   * turn — so a same-model turn keeps its continuation optimization, while a
   * model change forces the next request to do a full history replay
   * instead of chaining off a response id that belongs to a different model.
   */
  prepareProviderConversation(provider: string, model: string): void {
    this.providerConversation.prepare(provider, model);
  }

  /** Clear conversation history */
  clear(): void {
    this.messages = [];
    this.aborted = false;
    this.providerConversation.reset();
    clearChatGPTOAuthState();
  }

  /** Export API messages for persistence */
  exportMessages(): UnifiedMessage[] {
    return this.messages;
  }

  /**
   * Restore API messages from persistence.
   *
   * Sanitized on the way in: this is the single choke point every session
   * resume/hydration goes through (SessionRuntime's constructor calls this
   * immediately after loading a workspace from disk - see
   * sessions/runtime/runtime.ts), so it's the most general place to repair
   * any tool_use/tool_result pairing broken by an earlier interruption
   * (macOS sleep or lost connection mid-turn, a force-quit, a buggy
   * session migration/import, etc.) before the history is ever replayed to
   * a provider. See tool-call-pairing.ts for the full rationale.
   */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = sanitizeToolCallPairing(messages);
  }

  /**
   * Reset provider continuation state (e.g. OpenAI Responses'
   * `previous_response_id`, ChatGPT OAuth/Codex replay state) without
   * touching in-memory message history. Used by the "reload from disk"
   * recovery path: a migrated or hand-trimmed session must never resume via
   * a stale/foreign continuation token — the next request must do a full
   * provider-neutral history bootstrap from the (possibly just-edited)
   * message list instead.
   */
  resetContinuationState(): void {
    this.providerConversation.reset();
    clearChatGPTOAuthState();
  }

  /** Export the full conversation as a readable markdown transcript */
  async exportTranscript(): Promise<string> {
    const skillCatalog = await this.skills.catalogForPrompt();
    const systemPrompt = buildSystemPrompt({
      userInstructions: this.settings.customInstructions,
      skillCatalog,
    });

    const parts: string[] = [
      `# Chatting with AI Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${this.settings.provider}`,
      `**Model:** ${this.settings.model}`,
      ``,
      `## System Prompt`,
      ``,
      "```",
      systemPrompt,
      "```",
      ``,
      `## Conversation`,
      ``,
    ];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
        parts.push(``);
        parts.push(msg.content);
        parts.push(``);
      } else {
        // Content blocks
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push(`### Assistant`);
            parts.push(``);
            parts.push(block.text);
            parts.push(``);
          } else if (block.type === "tool_use") {
            parts.push(`### Tool Call: \`${block.name}\``);
            parts.push(``);
            parts.push("```json");
            parts.push(JSON.stringify(block.input, null, 2));
            parts.push("```");
            parts.push(``);
          } else if (block.type === "tool_result") {
            parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`);
            parts.push(``);
            parts.push("```");
            parts.push(block.content || "(empty)");
            parts.push("```");
            parts.push(``);
          }
        }
      }
    }

    return parts.join("\n");
  }

  /** Run one user turn through the agentic loop */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    contextRefs: ContextRef[] = []
  ): Promise<void> {
    this.aborted = false;

    // Explicit `/skill <id> ...` or `/<id> ...` invocation: inject the full
    // Skill body for this turn only. Never persisted as "always active".
    let effectiveUserMessage = userMessage;
    const invocation = parseExplicitSkillInvocation(userMessage);
    if (invocation) {
      const doc = await this.skills.read(invocation.id);
      if (!doc || doc.userInvocable === false) {
        callbacks.onError(
          doc
            ? `Skill "${invocation.id}" is not user-invocable via slash command.`
            : `Skill not found: ${invocation.id}`
        );
        return;
      }
      effectiveUserMessage = [
        `[Explicit skill invocation: ${doc.id}]`,
        `Follow this Skill for the current task:`,
        doc.body,
        "",
        `User request:`,
        invocation.rest || userMessage,
      ].join("\n");
    }

    // Build context once per user turn and prepend to the user message
    const context = buildContext(this.app);
    const contextPrefix = buildContextMessage(context);

    // If there's a selection, inject it as scoped context
    let fullMessage: string;
    if (selection) {
      fullMessage = [
        contextPrefix,
        "",
        `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection. Do not modify text outside the selection.]`,
        "",
        `Selected text:`,
        `> ${selection.text}`,
        "",
        effectiveUserMessage,
      ].join("\n");
    } else {
      fullMessage = `${contextPrefix}\n\n${effectiveUserMessage}`;
    }

    this.messages.push({
      role: "user",
      content: fullMessage,
      contextRefs: contextRefs.length > 0 ? [...contextRefs] : undefined,
    });

    // Prune if conversation is too long
    this.pruneHistory();

    // Skill catalog is metadata-only (ids + descriptions); full Skill bodies
    // are loaded on demand via read_skill or explicit slash invocation above.
    const skillCatalog = await this.skills.catalogForPrompt();

    // Resolve the active Prompt Profile (if any) against current global
    // settings. This never mutates `this.settings` — it produces a per-turn
    // effective-settings object so disabling/switching a profile restores
    // global defaults immediately on the next turn.
    const { effective } = await this.profiles.resolve(this.settings.activeProfileId, {
      model: this.settings.model,
      effort: this.settings.reasoningEffort,
      enableWebSearch: this.settings.enableWebSearch,
    });
    const requestSettings: ChatSettings = {
      ...this.settings,
      model: effective.model,
      reasoningEffort: effective.effort,
      enableWebSearch: effective.enableWebSearch,
    };

    // System prompt is stable for this settings state (cache-friendly). Built
    // once per turn, identical across all iterations of this turn's loop.
    const systemPrompt = buildSystemPrompt({
      userInstructions: this.settings.customInstructions,
      profileInstructions: effective.profileInstructions,
      skillCatalog,
    });

    debugLog(this.app, "USER_MESSAGE", { userMessage, hasSelection: !!selection });

    const maxIterations = this.settings.maxIterations || 20;

    for (let i = 0; i < maxIterations; i++) {
      if (this.aborted) return;

      callbacks.onThinking();

      let response;
      try {
        response = await sendMessage(
          requestSettings,
          this.messages,
          TOOL_DEFINITIONS,
          systemPrompt,
          { images: this.imageResolver, providerConversation: this.providerConversation }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        debugLog(this.app, "API_ERROR", { error: msg, model: requestSettings.model, provider: requestSettings.provider });
        callbacks.onError(msg);
        return;
      }

      debugLog(this.app, "API_RESPONSE", { stopReason: response.stopReason, contentTypes: response.content.map(b => b.type), usage: response.usage });

      if (this.aborted) return;

      // Process response content blocks
      const toolCalls: ContentBlock[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push(block);
        }
      }

      // Emit any text before tool calls (skip if ask_user is coming to avoid
      // rendering the question twice: once as text and once via showAskUser)
      const hasAskUser = toolCalls.some((tc) => tc.name === "ask_user");
      if (textParts.length > 0 && toolCalls.length > 0 && !hasAskUser) {
        callbacks.onResponse(textParts.join(""));
      }

      // If no tool calls, this turn is plain text - safe to commit
      // immediately, there is no call/result pairing to protect.
      if (toolCalls.length === 0) {
        this.messages.push({ role: "assistant", content: response.content });
        if (textParts.length > 0) {
          callbacks.onResponse(textParts.join(""));
        }
        return;
      }

      // Execute tool calls and collect results. Deliberately do NOT touch
      // `this.messages` yet - see the commit below for why.
      const resultBlocks: ContentBlock[] = [];

      for (const tc of toolCalls) {
        if (this.aborted) break;

        callbacks.onToolCall(tc.name!, tc.input!);

        const result = await executeTool(
          this.app,
          tc.name!,
          tc.input!,
          callbacks.onAskUser
        );

        callbacks.onToolResult(tc.name!, result);

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
        });
      }

      // Any tool call this batch didn't get to (aborted partway through the
      // loop above) still needs a paired result - see the commit note.
      for (const tc of toolCalls) {
        if (!resultBlocks.some((r) => r.tool_use_id === tc.id)) {
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: "Cancelled before this tool call ran.",
            is_error: true,
          });
        }
      }

      /**
       * Commit the assistant's tool_use message and its tool_result message
       * TOGETHER, in this one synchronous step - never separately.
       *
       * This is the actual fix for "No tool call found for function call
       * output": every provider adapter replays this history as call_id-
       * paired items (function_call / function_call_output in Responses-API
       * terms), and a tool_use committed without its result is exactly the
       * malformed shape the backend rejects. Previously the assistant
       * message was pushed *before* executing the tools, so any
       * interruption between that push and the result push (macOS sleep,
       * lost network, a hung `ask_user` await, a future bug) left a
       * dangling call sitting in `this.messages` — which then got persisted
       * and/or replayed on the next turn.
       *
       * Committing both together closes that window entirely: whatever
       * happens during tool execution, `this.messages` (the thing that gets
       * persisted to disk and replayed to providers) either gains a fully
       * paired {tool_use, tool_result} turn, or gains nothing at all if
       * something above throws/hangs before we get here. "This turn simply
       * didn't happen yet" is the most honest state to leave history in —
       * no synthetic narrative, no orphaned call, nothing to reconcile on
       * resume. Fixed 2026-09-11; see also sanitizeToolCallPairing() for
       * the remaining role of after-the-fact repair (already-corrupted
       * sessions saved before this fix, and pruneHistory's positional
       * truncation, which is a different mechanism this doesn't address).
       */
      this.messages.push({ role: "assistant", content: response.content });
      this.messages.push({ role: "user", content: resultBlocks });

      if (this.aborted) return;
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /**
   * Drop oldest messages when conversation gets too long, keeping recent
   * context.
   *
   * `slice(-KEEP_RECENT)` is a plain positional cut with no awareness of
   * tool_use/tool_result pairing. If the cut point falls between a tool_use
   * message and its tool_result message (extremely likely in any
   * tool-heavy session, which is exactly when this path triggers), the
   * retained window keeps an orphaned tool_result whose tool_use got cut
   * away — precisely the "No tool call found for function call output"
   * shape the ChatGPT OAuth/Codex and OpenAI backends reject outright.
   * sanitizeToolCallPairing() repairs that (see its doc comment) before the
   * pruned history is used for anything else.
   */
  private pruneHistory(): void {
    if (this.messages.length > MAX_CONVERSATION_LENGTH) {
      this.messages = sanitizeToolCallPairing(this.messages.slice(-KEEP_RECENT));
    }
  }
}
