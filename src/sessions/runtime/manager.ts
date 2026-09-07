import type { SessionMetadata } from "../metadata/types";
import type { SessionWorkspaceStore, CreateSessionInput } from "../store";
import { SessionRuntime, type SessionAgentAdapter } from "./runtime";
import type {
  SessionQuery,
  SessionQueryResult,
  SessionRunOutcome,
  SessionRunRequest,
  SessionRuntimeEvent,
  SessionRuntimeSnapshot,
  SessionStoreStats,
} from "./types";

export interface SessionAgentFactory {
  create(metadata: SessionMetadata): SessionAgentAdapter;
}

export interface SessionManagerOptions {
  store: SessionWorkspaceStore;
  agentFactory: SessionAgentFactory;
  getDefaultSessionSeed: () => CreateSessionInput;
  /** Recommended: 2 on narrow/mobile, 3-4 on desktop. */
  maxConcurrentRuns?: number;
  /** Recommended: 6-10 hydrated idle runtimes. */
  maxHydratedRuntimes?: number;
  onBackgroundCompletion?: (sessionId: string, outcome: SessionRunOutcome) => void;
}

interface QueuedRun {
  sessionId: string;
  request: SessionRunRequest;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export type SessionManagerEvent =
  | { type: "catalog-changed"; sessionId?: string }
  | { type: "runtime-event"; sessionId: string; event: SessionRuntimeEvent }
  | { type: "view-binding"; viewId: string; sessionId: string | null };

/**
 * Owns all hydrated session runtimes. There is intentionally no plugin-global
 * activeSessionId: each Obsidian ChatView binds independently.
 */
export class SessionManager {
  private readonly store: SessionWorkspaceStore;
  private readonly agentFactory: SessionAgentFactory;
  private readonly getDefaultSessionSeed: () => CreateSessionInput;
  private readonly maxConcurrentRuns: number;
  private readonly maxHydratedRuntimes: number;
  private readonly onBackgroundCompletion?: SessionManagerOptions["onBackgroundCompletion"];

  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private readonly viewBindings = new Map<string, string>();
  private readonly visibleViews = new Set<string>();
  private readonly listeners = new Set<(event: SessionManagerEvent) => void>();
  private readonly queue: QueuedRun[] = [];
  private runningCount = 0;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.agentFactory = options.agentFactory;
    this.getDefaultSessionSeed = options.getDefaultSessionSeed;
    this.maxConcurrentRuns = clamp(options.maxConcurrentRuns ?? 3, 1, 6);
    this.maxHydratedRuntimes = clamp(options.maxHydratedRuntimes ?? 8, 2, 24);
    this.onBackgroundCompletion = options.onBackgroundCompletion;
  }

  subscribe(listener: (event: SessionManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(seed: CreateSessionInput = this.getDefaultSessionSeed()): Promise<SessionRuntimeSnapshot> {
    const workspace = await this.store.create(seed);
    this.emit({ type: "catalog-changed", sessionId: workspace.metadata.id });
    const runtime = await this.ensureRuntime(workspace.metadata.id);
    await this.evictIdleRuntimes();
    return runtime.snapshot();
  }

  async query(query: SessionQuery): Promise<SessionQueryResult> {
    return this.store.query(query);
  }

  async getStats(): Promise<SessionStoreStats> {
    return this.store.getStats();
  }

  getRuntimePhase(sessionId: string): SessionRuntimeSnapshot["phase"] {
    return this.runtimes.get(sessionId)?.status ?? "idle";
  }

  getRuntimePhases(): ReadonlyMap<string, SessionRuntimeSnapshot["phase"]> {
    const phases = new Map<string, SessionRuntimeSnapshot["phase"]>();
    for (const [id, runtime] of this.runtimes) phases.set(id, runtime.status);
    return phases;
  }

  async getUnreadMap(ids: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const map = new Map<string, boolean>();
    await Promise.all(ids.map(async (id) => {
      const runtime = this.runtimes.get(id);
      if (runtime) map.set(id, runtime.snapshot().localState.hasUnreadActivity);
      else {
        const loaded = await this.store.local.load(id);
        map.set(id, loaded.hasUnreadActivity);
      }
    }));
    return map;
  }

  async bindView(viewId: string, requestedSessionId?: string | null): Promise<SessionRuntimeSnapshot> {
    let sessionId = requestedSessionId ?? null;
    if (!sessionId || !(await this.store.getMeta(sessionId))) {
      const recent = await this.store.query({ scope: "active", limit: 1 });
      sessionId = recent.items[0]?.id ?? (await this.createSession()).metadata.id;
    }
    this.viewBindings.set(viewId, sessionId);
    this.visibleViews.add(viewId);
    const runtime = await this.ensureRuntime(sessionId);
    await runtime.markRead();
    this.emit({ type: "view-binding", viewId, sessionId });
    return runtime.snapshot();
  }

  async switchView(viewId: string, sessionId: string): Promise<SessionRuntimeSnapshot> {
    if (!(await this.store.getMeta(sessionId))) throw new Error(`Session not found: ${sessionId}`);
    this.viewBindings.set(viewId, sessionId);
    const runtime = await this.ensureRuntime(sessionId);
    await runtime.markRead();
    this.emit({ type: "view-binding", viewId, sessionId });
    await this.evictIdleRuntimes();
    return runtime.snapshot();
  }

  unbindView(viewId: string): void {
    this.viewBindings.delete(viewId);
    this.visibleViews.delete(viewId);
    // Do not abort; runtime lifetime is independent from view lifetime.
  }

  setViewVisible(viewId: string, visible: boolean): void {
    if (visible) this.visibleViews.add(viewId);
    else this.visibleViews.delete(viewId);
  }

  getBoundSessionId(viewId: string): string | null {
    return this.viewBindings.get(viewId) ?? null;
  }

  async subscribeView(viewId: string, listener: (event: SessionRuntimeEvent) => void): Promise<() => void> {
    const id = this.viewBindings.get(viewId);
    if (!id) throw new Error(`View ${viewId} is not bound to a session.`);
    return (await this.ensureRuntime(id)).subscribe(listener);
  }

  async runForView(viewId: string, request: SessionRunRequest): Promise<void> {
    const id = this.viewBindings.get(viewId);
    if (!id) throw new Error(`View ${viewId} is not bound to a session.`);
    return this.run(id, request);
  }

  async run(sessionId: string, request: SessionRunRequest): Promise<void> {
    const meta = await this.store.getMeta(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (meta.isArchived) throw new Error("Unarchive this conversation before sending.");
    const runtime = await this.ensureRuntime(sessionId);
    if (runtime.status !== "idle") throw new Error(`Session is already ${runtime.status}.`);

    if (this.runningCount >= this.maxConcurrentRuns) {
      runtime.setQueued();
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ sessionId, request, resolve, reject });
      });
    }
    return this.startRuntime(runtime, request);
  }

  async stop(sessionId: string): Promise<void> {
    const queuedIndex = this.queue.findIndex((item) => item.sessionId === sessionId);
    if (queuedIndex >= 0) {
      const [item] = this.queue.splice(queuedIndex, 1);
      this.runtimes.get(sessionId)?.cancelQueued();
      item.resolve();
      return;
    }
    await this.runtimes.get(sessionId)?.stop();
  }

  async answer(sessionId: string, answer: string): Promise<boolean> {
    return (await this.ensureRuntime(sessionId)).answerPendingQuestion(answer);
  }

  /**
   * Recovery path: re-reads `<sessionId>.jsonl` fresh from disk (e.g. after a
   * hand-edit to remove an oversized tool result), fully replacing this one
   * session's in-memory history and provider continuation without touching
   * any other session's live runtime. Refuses (never aborts) while this
   * particular session is mid-turn; other sessions may run concurrently
   * throughout.
   */
  async reloadFromDisk(sessionId: string): Promise<SessionRuntimeSnapshot> {
    const existing = this.runtimes.get(sessionId);
    if (existing?.isBusy) {
      throw new Error(`Session is already ${existing.status}; stop it before reloading from disk.`);
    }
    if (existing) {
      this.runtimeUnsubscribers.get(sessionId)?.();
      this.runtimeUnsubscribers.delete(sessionId);
      this.runtimes.delete(sessionId);
      // Discard (not dispose): a normal dispose flushes in-memory state to
      // disk, which would immediately clobber the just hand-edited file.
      await existing.discard();
    }
    const runtime = await this.ensureRuntime(sessionId);
    this.emit({ type: "catalog-changed", sessionId });
    return runtime.snapshot();
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) {
      const next = await this.store.rename(sessionId, title);
      if (!next) throw new Error(`Session not found: ${sessionId}`);
    } else if (runtime) {
      await runtime.updateMetadata((metadata) => ({ ...metadata, title: title.trim() || metadata.title }));
    } else {
      const next = await this.store.rename(sessionId, title);
      if (!next) throw new Error(`Session not found: ${sessionId}`);
    }
    this.emit({ type: "catalog-changed", sessionId });
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) await this.store.setPinned(sessionId, pinned);
    else if (runtime) await runtime.updateMetadata((metadata) => ({ ...metadata, isPinned: pinned }));
    else await this.store.setPinned(sessionId, pinned);
    this.emit({ type: "catalog-changed", sessionId });
  }

  async setSelectedModel(sessionId: string, model: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) throw new Error("Change model after the current turn completes.");
    if (runtime) await runtime.updateMetadata((metadata) => ({ ...metadata, selectedModel: model }));
    else await this.store.setSelectedModel(sessionId, model);
    this.emit({ type: "catalog-changed", sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) throw new Error("Stop this conversation before archiving it.");
    await runtime?.flush();
    await this.store.setArchived(sessionId, true);
    await this.disposeRuntime(sessionId);
    this.emit({ type: "catalog-changed", sessionId });
    await this.rebindViewsAwayFrom(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.store.setArchived(sessionId, false);
    this.emit({ type: "catalog-changed", sessionId });
  }

  async fork(sessionId: string): Promise<SessionRuntimeSnapshot> {
    const fork = await this.store.fork(sessionId);
    if (!fork) throw new Error(`Session not found: ${sessionId}`);
    this.emit({ type: "catalog-changed", sessionId: fork.metadata.id });
    return (await this.ensureRuntime(fork.metadata.id)).snapshot();
  }

  async delete(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) throw new Error("Stop this conversation before deleting it.");
    await this.disposeRuntime(sessionId);
    await this.store.delete(sessionId);
    this.emit({ type: "catalog-changed", sessionId });
    await this.rebindViewsAwayFrom(sessionId);
  }

  async setDraftForView(viewId: string, text: string, contextRefs: SessionRuntimeSnapshot["localState"]["draft"]["contextRefs"]): Promise<void> {
    const id = this.viewBindings.get(viewId);
    if (!id) return;
    await (await this.ensureRuntime(id)).setDraft(text, contextRefs);
  }

  async shutdown(): Promise<void> {
    for (const queued of this.queue.splice(0)) {
      this.runtimes.get(queued.sessionId)?.cancelQueued();
      queued.resolve();
    }
    const runtimes = [...this.runtimes.values()];
    await Promise.all(runtimes.map(async (runtime) => {
      if (runtime.isBusy) await runtime.stop();
      await runtime.flush();
      await runtime.dispose();
    }));
    this.runtimes.clear();
    this.runtimeUnsubscribers.clear();
  }

  private async ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const workspace = await this.store.load(sessionId);
    if (!workspace) throw new Error(`Session not found: ${sessionId}`);
    const runtime = new SessionRuntime({
      workspace,
      agent: this.agentFactory.create(workspace.metadata),
      store: this.store,
      onTerminal: (finished, outcome) => void this.handleTerminal(finished, outcome),
    });
    const unsubscribe = runtime.subscribe((event) => {
      this.emit({ type: "runtime-event", sessionId, event });
    });
    this.runtimes.set(sessionId, runtime);
    this.runtimeUnsubscribers.set(sessionId, unsubscribe);
    await this.evictIdleRuntimes();
    return runtime;
  }

  private async startRuntime(runtime: SessionRuntime, request: SessionRunRequest): Promise<void> {
    this.runningCount++;
    try {
      await runtime.run(request);
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainQueue();
      await this.evictIdleRuntimes();
    }
  }

  private drainQueue(): void {
    while (this.runningCount < this.maxConcurrentRuns && this.queue.length > 0) {
      const item = this.queue.shift()!;
      const runtime = this.runtimes.get(item.sessionId);
      if (!runtime || runtime.status !== "queued") {
        item.resolve();
        continue;
      }
      void this.startRuntime(runtime, item.request).then(item.resolve, item.reject);
    }
  }

  private async handleTerminal(runtime: SessionRuntime, outcome: SessionRunOutcome): Promise<void> {
    const visible = [...this.viewBindings].some(([viewId, sessionId]) => (
      sessionId === runtime.id && this.visibleViews.has(viewId)
    ));
    if (!visible && outcome !== "stopped") {
      await runtime.markUnread();
      this.onBackgroundCompletion?.(runtime.id, outcome);
    }
    this.emit({ type: "catalog-changed", sessionId: runtime.id });
  }

  private async rebindViewsAwayFrom(sessionId: string): Promise<void> {
    const affected = [...this.viewBindings.entries()]
      .filter(([, id]) => id === sessionId)
      .map(([viewId]) => viewId);
    if (affected.length === 0) return;
    const recent = await this.store.query({ scope: "active", limit: 1 });
    const replacementId = recent.items[0]?.id ?? (await this.createSession()).metadata.id;
    for (const viewId of affected) {
      this.viewBindings.set(viewId, replacementId);
      this.emit({ type: "view-binding", viewId, sessionId: replacementId });
    }
  }

  private async evictIdleRuntimes(): Promise<void> {
    if (this.runtimes.size <= this.maxHydratedRuntimes) return;
    const boundIds = new Set(this.viewBindings.values());
    const candidates = [...this.runtimes.values()]
      .filter((runtime) => runtime.canEvict && !boundIds.has(runtime.id))
      .sort((a, b) => a.touchedAt - b.touchedAt);
    while (this.runtimes.size > this.maxHydratedRuntimes && candidates.length > 0) {
      await this.disposeRuntime(candidates.shift()!.id);
    }
  }

  private async disposeRuntime(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    if (runtime.isBusy) return;
    this.runtimeUnsubscribers.get(sessionId)?.();
    this.runtimeUnsubscribers.delete(sessionId);
    this.runtimes.delete(sessionId);
    await runtime.dispose();
  }

  private emit(event: SessionManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
