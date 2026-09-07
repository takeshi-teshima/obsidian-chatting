import type { UnifiedMessage, ToolResult } from "../types";
import type {
  PersistedSession,
  SessionRunOutcome,
  SessionRunPhase,
  SessionRunRequest,
  SessionRuntimeEvent,
  SessionRuntimeSnapshot,
} from "./types";
import { createHistoryId, deriveSessionPreview } from "./types";

export interface SessionAgentCallbacks {
  onThinking: () => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (message: string) => void;
}

/**
 * Adapter around AgentLoop. The merge layer implements this interface so the
 * session subsystem does not depend on UI or provider-specific globals.
 */
export interface SessionAgentAdapter {
  run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void>;
  abort(): void;
  exportMessages(): UnifiedMessage[];
  importMessages(messages: UnifiedMessage[]): void;
  /** Must clear only this runtime's server continuation state. */
  resetProviderContinuation(): void;
}

export type RuntimeListener = (event: SessionRuntimeEvent) => void;

export interface SessionRuntimeOptions {
  session: PersistedSession;
  agent: SessionAgentAdapter;
  persist: (session: PersistedSession) => Promise<PersistedSession>;
  onTerminal?: (runtime: SessionRuntime, outcome: SessionRunOutcome) => void;
}

/**
 * One runtime per conversation. It owns exactly one AgentLoop adapter, pending
 * ask_user promise, run state, and provider continuation state.
 *
 * A view may attach/detach at any time. Detaching never aborts the run.
 */
export class SessionRuntime {
  private session: PersistedSession;
  private readonly agent: SessionAgentAdapter;
  private readonly persistFn: SessionRuntimeOptions["persist"];
  private readonly onTerminal?: SessionRuntimeOptions["onTerminal"];
  private readonly listeners = new Set<RuntimeListener>();
  private phase: SessionRunPhase = "idle";
  private queuedAt: number | null = null;
  private pendingQuestion: string | null = null;
  private pendingQuestionResolve: ((answer: string) => void) | null = null;
  private runPromise: Promise<void> | null = null;
  private stopRequested = false;
  private lastTouchedAt = Date.now();

  constructor(options: SessionRuntimeOptions) {
    this.session = options.session;
    this.agent = options.agent;
    this.persistFn = options.persist;
    this.onTerminal = options.onTerminal;
    this.agent.importMessages(options.session.agentMessages);
    // A hydrated/restored runtime starts with no trusted server continuation id.
    this.agent.resetProviderContinuation();
  }

  get id(): string { return this.session.id; }
  get status(): SessionRunPhase { return this.phase; }
  get touchedAt(): number { return this.lastTouchedAt; }
  get isBusy(): boolean { return this.phase !== "idle"; }
  get canEvict(): boolean { return this.phase === "idle"; }

  snapshot(): SessionRuntimeSnapshot {
    return {
      session: cloneSession(this.session),
      phase: this.phase,
      pendingQuestion: this.pendingQuestion,
      queuedAt: this.queuedAt,
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.snapshot() });
    this.touch();
    return () => this.listeners.delete(listener);
  }

  setQueued(): void {
    if (this.phase !== "idle") throw new Error(`Session ${this.id} is already ${this.phase}.`);
    this.phase = "queued";
    this.queuedAt = Date.now();
    this.emit({ type: "run-state", phase: this.phase });
  }

  cancelQueued(): boolean {
    if (this.phase !== "queued") return false;
    this.phase = "idle";
    this.queuedAt = null;
    this.emit({ type: "run-state", phase: this.phase });
    return true;
  }

  async run(request: SessionRunRequest): Promise<void> {
    if (this.phase !== "idle" && this.phase !== "queued") {
      throw new Error(`Session ${this.id} is already ${this.phase}.`);
    }
    if (!request.text.trim() && !(request.contextRefs?.length)) return;

    this.phase = "running";
    this.stopRequested = false;
    this.queuedAt = null;
    const now = Date.now();
    this.session.lastActivityAt = now;
    this.session.recovery = { phase: "running", startedAt: now, updatedAt: now };
    this.session.lastError = undefined;
    this.session.chatHistory.push({
      id: createHistoryId(now),
      type: "user",
      timestamp: now,
      text: request.text,
      contextRefs: request.contextRefs ? [...request.contextRefs] : undefined,
    });
    this.refreshDerivedMetadata();
    await this.persistNow();
    this.emit({ type: "run-state", phase: this.phase });

    let callbackError: string | null = null;
    this.runPromise = this.agent.run(request, {
      onThinking: () => this.emit({ type: "thinking" }),
      onToolCall: (name, input) => this.emit({ type: "tool-call", name, input }),
      onToolResult: (name, result) => {
        const timestamp = Date.now();
        this.session.chatHistory.push({
          id: createHistoryId(timestamp),
          type: "tool-result",
          timestamp,
          toolName: name,
          toolResult: result,
        });
        this.session.lastActivityAt = timestamp;
        this.refreshDerivedMetadata();
        this.emit({ type: "tool-result", name, result });
      },
      onResponse: (text) => {
        const timestamp = Date.now();
        this.session.chatHistory.push({
          id: createHistoryId(timestamp),
          type: "assistant",
          timestamp,
          text,
        });
        this.session.lastActivityAt = timestamp;
        this.refreshDerivedMetadata();
        this.emit({ type: "assistant", text });
      },
      onAskUser: (question) => this.waitForUser(question),
      onError: (message) => {
        callbackError = message;
        const timestamp = Date.now();
        this.session.chatHistory.push({
          id: createHistoryId(timestamp),
          type: "error",
          timestamp,
          text: message,
        });
        this.session.lastError = message;
        this.session.lastActivityAt = timestamp;
        this.refreshDerivedMetadata();
        this.emit({ type: "error", message });
      },
    });

    try {
      await this.runPromise;
      await this.finish(this.stopRequested ? "stopped" : callbackError ? "error" : "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.session.lastError = message;
      this.emit({ type: "error", message });
      await this.finish(this.stopRequested ? "stopped" : "error");
    } finally {
      this.runPromise = null;
    }
  }

  answerPendingQuestion(answer: string): boolean {
    if (this.phase !== "waiting_user" || !this.pendingQuestionResolve) return false;
    const resolve = this.pendingQuestionResolve;
    this.pendingQuestionResolve = null;
    this.pendingQuestion = null;
    this.phase = "running";
    if (this.session.recovery) {
      this.session.recovery = {
        ...this.session.recovery,
        phase: "running",
        updatedAt: Date.now(),
        pendingQuestion: undefined,
      };
    }
    this.emit({ type: "run-state", phase: this.phase });
    resolve(answer);
    return true;
  }

  async stop(): Promise<void> {
    if (this.phase === "queued") {
      this.cancelQueued();
      return;
    }
    if (this.phase === "idle" || this.phase === "stopping") return;
    this.stopRequested = true;
    this.phase = "stopping";
    this.emit({ type: "run-state", phase: this.phase });
    this.agent.abort();
    // If ask_user is blocking, release it so the loop can observe abort/finish.
    if (this.pendingQuestionResolve) {
      const resolve = this.pendingQuestionResolve;
      this.pendingQuestionResolve = null;
      this.pendingQuestion = null;
      resolve("");
    }
    try { await this.runPromise; } catch { /* finish() owns terminal state */ }
    if ((this.phase as SessionRunPhase) !== "idle") await this.finish("stopped");
  }

  async updateMetadata(patch: Partial<Pick<PersistedSession,
    "title" | "isPinned" | "isArchived" | "hasUnreadActivity" | "preferences"
  >>): Promise<void> {
    this.session = { ...this.session, ...patch };
    await this.persistNow();
  }

  async setDraft(text: string, contextRefs = this.session.draft.contextRefs): Promise<void> {
    this.session.draft = { text, contextRefs: [...contextRefs] };
    this.touch();
    await this.persistNow();
  }

  async markRead(): Promise<void> {
    if (!this.session.hasUnreadActivity) return;
    this.session.hasUnreadActivity = false;
    await this.persistNow();
  }

  async markUnread(): Promise<void> {
    if (this.session.hasUnreadActivity) return;
    this.session.hasUnreadActivity = true;
    await this.persistNow();
  }

  async flush(): Promise<void> {
    this.session.agentMessages = this.agent.exportMessages();
    await this.persistNow();
  }

  private waitForUser(question: string): Promise<string> {
    this.phase = "waiting_user";
    this.pendingQuestion = question;
    if (this.session.recovery) {
      this.session.recovery = {
        ...this.session.recovery,
        phase: "waiting_user",
        updatedAt: Date.now(),
        pendingQuestion: question,
      };
    }
    void this.persistNow();
    this.emit({ type: "run-state", phase: this.phase });
    this.emit({ type: "ask-user", question });
    return new Promise((resolve) => { this.pendingQuestionResolve = resolve; });
  }

  private async finish(outcome: SessionRunOutcome): Promise<void> {
    this.phase = "idle";
    this.queuedAt = null;
    this.pendingQuestion = null;
    this.pendingQuestionResolve = null;
    this.session.recovery = undefined;
    this.session.lastOutcome = outcome;
    this.stopRequested = false;
    this.session.lastActivityAt = Date.now();
    this.session.agentMessages = this.agent.exportMessages();
    this.refreshDerivedMetadata();
    await this.persistNow();
    this.emit({ type: "run-state", phase: this.phase });
    this.emit({ type: "run-complete", outcome });
    this.onTerminal?.(this, outcome);
  }

  private refreshDerivedMetadata(): void {
    this.session.messageCount = this.session.chatHistory.length;
    this.session.preview = deriveSessionPreview(this.session.chatHistory);
  }

  private async persistNow(): Promise<void> {
    this.session.agentMessages = this.agent.exportMessages();
    this.session = await this.persistFn(this.session);
    this.touch();
  }

  private emit(event: SessionRuntimeEvent): void {
    this.touch();
    for (const listener of this.listeners) listener(event);
  }

  private touch(): void { this.lastTouchedAt = Date.now(); }
}

function cloneSession(session: PersistedSession): PersistedSession {
  // Session state is intentionally JSON-safe. structuredClone is available in
  // modern Obsidian WebViews; JSON fallback keeps older mobile versions safe.
  if (typeof structuredClone === "function") return structuredClone(session);
  return JSON.parse(JSON.stringify(session)) as PersistedSession;
}
