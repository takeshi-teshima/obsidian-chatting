import type { ToolResult, UnifiedMessage } from "../../types";
import type { SessionMetadata } from "../metadata/types";
import type { SessionWorkspaceStore } from "../store";
import type {
  LoadedSessionWorkspace,
  SessionRunOutcome,
  SessionRunPhase,
  SessionRunRequest,
  SessionRuntimeEvent,
  SessionRuntimeSnapshot,
} from "./types";
import { SerialQueue } from "./async-lock";

export interface SessionAgentCallbacks {
  onThinking: () => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (message: string) => void;
}

/** Adapter around one AgentLoop instance. One adapter belongs to one session. */
export interface SessionAgentAdapter {
  run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void>;
  abort(): void;
  exportMessages(): UnifiedMessage[];
  importMessages(messages: UnifiedMessage[]): void;
  /** Clears only this session runtime's server-side continuation optimization. */
  resetProviderContinuation(): void;
  /** Optional hook when selectedModel/providerState changes while idle. */
  applySessionMetadata?(metadata: SessionMetadata): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type RuntimeListener = (event: SessionRuntimeEvent) => void;

export interface SessionRuntimeOptions {
  workspace: LoadedSessionWorkspace;
  agent: SessionAgentAdapter;
  store: SessionWorkspaceStore;
  onTerminal?: (runtime: SessionRuntime, outcome: SessionRunOutcome) => void;
}

/**
 * One runtime per logical conversation. Views may attach/detach without owning
 * or aborting it. Cross-session concurrency is therefore natural; same-session
 * concurrent turns remain forbidden.
 */
export class SessionRuntime {
  private workspace: LoadedSessionWorkspace;
  private readonly agent: SessionAgentAdapter;
  private readonly store: SessionWorkspaceStore;
  private readonly onTerminal?: SessionRuntimeOptions["onTerminal"];
  private readonly listeners = new Set<RuntimeListener>();
  private readonly checkpointQueue = new SerialQueue();
  private phase: SessionRunPhase = "idle";
  private queuedAt: number | null = null;
  private pendingQuestion: string | null = null;
  private pendingQuestionResolve: ((answer: string) => void) | null = null;
  private runPromise: Promise<void> | null = null;
  private stopRequested = false;
  private lastTouchedAt = Date.now();

  constructor(options: SessionRuntimeOptions) {
    this.workspace = options.workspace;
    this.agent = options.agent;
    this.store = options.store;
    this.onTerminal = options.onTerminal;
    this.agent.importMessages(this.workspace.messages);
    // Hydration never trusts process-local/server continuation ids from a prior runtime.
    this.agent.resetProviderContinuation();
  }

  get id(): string { return this.workspace.metadata.id; }
  get status(): SessionRunPhase { return this.phase; }
  get touchedAt(): number { return this.lastTouchedAt; }
  get isBusy(): boolean { return this.phase !== "idle"; }
  get canEvict(): boolean { return this.phase === "idle"; }

  snapshot(): SessionRuntimeSnapshot {
    return {
      metadata: clone(this.workspace.metadata),
      messages: clone(this.workspace.messages),
      localState: clone(this.workspace.localState),
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
    this.workspace.metadata.lastActivityAt = Math.max(this.workspace.metadata.lastActivityAt, now);
    this.workspace.localState.lastError = undefined;
    this.workspace.localState.recovery = {
      phase: "running",
      startedAt: now,
      updatedAt: now,
      pendingInput: {
        text: request.text,
        ...(request.contextRefs?.length ? { contextRefs: [...request.contextRefs] } : {}),
      },
    };
    await this.store.saveLocalState(this.workspace.localState);
    this.emit({ type: "run-state", phase: this.phase });

    let callbackError: string | null = null;
    this.runPromise = this.agent.run(request, {
      onThinking: () => this.emit({ type: "thinking" }),
      onToolCall: (name, input) => this.emit({ type: "tool-call", name, input }),
      onToolResult: (name, result) => {
        this.workspace.metadata.lastActivityAt = Date.now();
        this.emit({ type: "tool-result", name, result });
        void this.checkpointMessages();
      },
      onResponse: (text) => {
        this.workspace.metadata.lastActivityAt = Date.now();
        this.emit({ type: "assistant", text });
        void this.checkpointMessages();
      },
      onAskUser: (question) => this.waitForUser(question),
      onError: (message) => {
        callbackError = message;
        this.workspace.localState.lastError = message;
        this.workspace.metadata.lastActivityAt = Date.now();
        this.emit({ type: "error", message });
        void this.checkpointMessages();
      },
    });

    try {
      await this.runPromise;
      await this.finish(this.stopRequested ? "stopped" : callbackError ? "error" : "completed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.workspace.localState.lastError = message;
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
    if (this.workspace.localState.recovery) {
      this.workspace.localState.recovery = {
        ...this.workspace.localState.recovery,
        phase: "running",
        updatedAt: Date.now(),
        pendingQuestion: undefined,
      };
      void this.store.saveLocalState(this.workspace.localState);
    }
    this.emit({ type: "run-state", phase: this.phase });
    resolve(answer);
    return true;
  }

  async stop(): Promise<void> {
    if (this.phase === "queued") { this.cancelQueued(); return; }
    if (this.phase === "idle" || this.phase === "stopping") return;
    this.stopRequested = true;
    this.phase = "stopping";
    this.emit({ type: "run-state", phase: this.phase });
    this.agent.abort();
    if (this.pendingQuestionResolve) {
      const resolve = this.pendingQuestionResolve;
      this.pendingQuestionResolve = null;
      this.pendingQuestion = null;
      resolve("");
    }
    try { await this.runPromise; } catch { /* finish owns terminal state */ }
    if ((this.phase as SessionRunPhase) !== "idle") await this.finish("stopped");
  }

  async updateMetadata(
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<void> {
    if (this.isBusy) throw new Error("Session execution configuration cannot be mutated while a turn is active.");
    const next = await this.store.updateMetadata(this.id, updater);
    if (!next) throw new Error(`Session not found: ${this.id}`);
    this.workspace.metadata = next;
    await this.agent.applySessionMetadata?.(next);
    this.touch();
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  async setDraft(text: string, contextRefs = this.workspace.localState.draft.contextRefs): Promise<void> {
    this.workspace.localState.draft = { text, contextRefs: [...contextRefs] };
    await this.store.saveLocalState(this.workspace.localState);
    this.touch();
  }

  async markRead(): Promise<void> {
    if (!this.workspace.localState.hasUnreadActivity) return;
    this.workspace.localState.hasUnreadActivity = false;
    await this.store.saveLocalState(this.workspace.localState);
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  async markUnread(): Promise<void> {
    if (this.workspace.localState.hasUnreadActivity) return;
    this.workspace.localState.hasUnreadActivity = true;
    await this.store.saveLocalState(this.workspace.localState);
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  async flush(): Promise<void> {
    await this.checkpointQueue.run(async () => {
      this.workspace.messages = this.agent.exportMessages();
      const saved = await this.store.saveWorkspace(this.workspace);
      this.workspace = saved;
    });
  }

  async dispose(): Promise<void> {
    await this.flush();
    await this.agent.dispose?.();
    this.listeners.clear();
  }

  /**
   * Tears down this runtime WITHOUT flushing in-memory state to disk. Only
   * safe to call while idle. Used exclusively by the "reload from disk"
   * recovery path (SessionManager.reloadFromDisk): the whole point of that
   * feature is to pick up an externally hand-edited `.jsonl`, so a normal
   * flush-on-dispose would immediately overwrite the user's edit with the
   * stale in-memory copy.
   */
  async discard(): Promise<void> {
    if (this.isBusy) throw new Error(`Cannot discard session ${this.id} while it is ${this.phase}.`);
    await this.agent.dispose?.();
    this.listeners.clear();
  }

  private waitForUser(question: string): Promise<string> {
    this.phase = "waiting_user";
    this.pendingQuestion = question;
    if (this.workspace.localState.recovery) {
      this.workspace.localState.recovery = {
        ...this.workspace.localState.recovery,
        phase: "waiting_user",
        updatedAt: Date.now(),
        pendingQuestion: question,
      };
      void this.store.saveLocalState(this.workspace.localState);
    }
    void this.checkpointMessages();
    this.emit({ type: "run-state", phase: this.phase });
    this.emit({ type: "ask-user", question });
    return new Promise((resolve) => { this.pendingQuestionResolve = resolve; });
  }

  private async finish(outcome: SessionRunOutcome): Promise<void> {
    this.phase = "idle";
    this.queuedAt = null;
    this.pendingQuestion = null;
    this.pendingQuestionResolve = null;
    delete this.workspace.localState.recovery;
    this.workspace.localState.lastOutcome = outcome;
    this.stopRequested = false;
    this.workspace.metadata.lastActivityAt = Date.now();
    this.workspace.messages = this.agent.exportMessages();
    this.workspace = await this.store.saveWorkspace(this.workspace);
    this.emit({ type: "run-state", phase: this.phase });
    this.emit({ type: "run-complete", outcome });
    this.onTerminal?.(this, outcome);
  }

  private checkpointMessages(): Promise<void> {
    return this.checkpointQueue.run(async () => {
      this.workspace.messages = this.agent.exportMessages();
      const saved = await this.store.saveHistoryAndActivity(
        this.id,
        this.workspace.messages,
        this.workspace.metadata.lastActivityAt,
      );
      if (saved) {
        // preserve current in-memory local state; saveHistoryAndActivity loads its own copy.
        this.workspace.metadata = saved.metadata;
        this.workspace.unknownMetadataFields = saved.unknownMetadataFields;
      }
    });
  }

  private emit(event: SessionRuntimeEvent): void {
    this.touch();
    for (const listener of this.listeners) listener(event);
  }
  private touch(): void { this.lastTouchedAt = Date.now(); }
}

function clone<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
