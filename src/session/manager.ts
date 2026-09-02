import type { ChatSettings } from "../types";
import type {
  PersistedSession,
  SessionPreferences,
  SessionQuery,
  SessionQueryResult,
  SessionRunOutcome,
  SessionRunRequest,
  SessionRuntimeEvent,
  SessionRuntimeSnapshot,
  SessionSummary,
  SessionStoreStats,
} from "./types";
import { SessionRuntime, type SessionAgentAdapter } from "./runtime";
import { SessionConflictError, SessionStore } from "./store";

export interface SessionAgentFactory {
  create(session: PersistedSession): SessionAgentAdapter;
}

export interface SessionManagerOptions {
  store: SessionStore;
  agentFactory: SessionAgentFactory;
  getDefaultPreferences: () => SessionPreferences;
  /** Defaults should stay small on mobile. Recommended: 2 mobile, 3 desktop. */
  maxConcurrentRuns?: number;
  /** Number of hydrated idle runtimes retained. Recommended 6-10. */
  maxHydratedRuntimes?: number;
  onBackgroundCompletion?: (summary: SessionSummary, outcome: SessionRunOutcome) => void;
  onStoreConflict?: (error: SessionConflictError) => void;
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
 * Owns all hydrated runtimes. There is deliberately no plugin-global activeSessionId:
 * each Obsidian view binds independently to a session.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly agentFactory: SessionAgentFactory;
  private readonly getDefaultPreferences: () => SessionPreferences;
  private readonly maxConcurrentRuns: number;
  private readonly maxHydratedRuntimes: number;
  private readonly onBackgroundCompletion?: SessionManagerOptions["onBackgroundCompletion"];
  private readonly onStoreConflict?: SessionManagerOptions["onStoreConflict"];

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
    this.getDefaultPreferences = options.getDefaultPreferences;
    this.maxConcurrentRuns = clamp(options.maxConcurrentRuns ?? 3, 1, 6);
    this.maxHydratedRuntimes = clamp(options.maxHydratedRuntimes ?? 8, 2, 24);
    this.onBackgroundCompletion = options.onBackgroundCompletion;
    this.onStoreConflict = options.onStoreConflict;
  }

  subscribe(listener: (event: SessionManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(title?: string): Promise<PersistedSession> {
    const session = await this.store.createBlank(this.getDefaultPreferences(), title ?? "New chat");
    this.emit({ type: "catalog-changed", sessionId: session.id });
    await this.evictIdleRuntimes();
    return session;
  }

  async query(query: SessionQuery): Promise<SessionQueryResult> {
    return this.store.query(query);
  }

  async getStats(): Promise<SessionStoreStats> {
    return this.store.getStats();
  }

  /**
   * Phases of currently-hydrated runtimes only. Deliberately does not
   * hydrate anything: session browser rows for non-hydrated sessions show
   * "idle" (accurate — a session with no runtime cannot be running).
   */
  getHydratedPhases(): Map<string, import("./types").SessionRunPhase> {
    const phases = new Map<string, import("./types").SessionRunPhase>();
    for (const runtime of this.runtimes.values()) phases.set(runtime.id, runtime.status);
    return phases;
  }

  async bindView(viewId: string, requestedSessionId?: string | null): Promise<SessionRuntimeSnapshot> {
    let sessionId = requestedSessionId ?? null;
    if (!sessionId || !(await this.store.getSummary(sessionId))) {
      const recent = await this.store.query({ scope: "active", limit: 1 });
      sessionId = recent.items[0]?.id ?? (await this.createSession()).id;
    }
    this.viewBindings.set(viewId, sessionId);
    this.visibleViews.add(viewId);
    const runtime = await this.ensureRuntime(sessionId);
    await runtime.markRead();
    this.emit({ type: "view-binding", viewId, sessionId });
    return runtime.snapshot();
  }

  async switchView(viewId: string, sessionId: string): Promise<SessionRuntimeSnapshot> {
    if (!(await this.store.getSummary(sessionId))) throw new Error(`Session not found: ${sessionId}`);
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
    // Crucially: do NOT abort the runtime. Background work remains alive.
  }

  setViewVisible(viewId: string, visible: boolean): void {
    if (visible) this.visibleViews.add(viewId);
    else this.visibleViews.delete(viewId);
  }

  getBoundSessionId(viewId: string): string | null {
    return this.viewBindings.get(viewId) ?? null;
  }

  async subscribeView(
    viewId: string,
    listener: (event: SessionRuntimeEvent) => void,
  ): Promise<() => void> {
    const id = this.viewBindings.get(viewId);
    if (!id) throw new Error(`View ${viewId} is not bound to a session.`);
    const runtime = await this.ensureRuntime(id);
    return runtime.subscribe(listener);
  }

  async runForView(viewId: string, request: SessionRunRequest): Promise<void> {
    const id = this.viewBindings.get(viewId);
    if (!id) throw new Error(`View ${viewId} is not bound to a session.`);
    return this.run(id, request);
  }

  async run(sessionId: string, request: SessionRunRequest): Promise<void> {
    await this.assertNotArchivedMutation(sessionId, false);
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
      const runtime = this.runtimes.get(sessionId);
      runtime?.cancelQueued();
      item.resolve();
      return;
    }
    const runtime = this.runtimes.get(sessionId);
    await runtime?.stop();
  }

  async answer(sessionId: string, answer: string): Promise<boolean> {
    const runtime = await this.ensureRuntime(sessionId);
    return runtime.answerPendingQuestion(answer);
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.assertNotArchivedMutation(sessionId, false);
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      const current = runtime.snapshot().session.title;
      await runtime.updateMetadata({ title: title.trim() || current });
    } else {
      await this.store.rename(sessionId, title);
    }
    this.emit({ type: "catalog-changed", sessionId });
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) await runtime.updateMetadata({ isPinned: pinned });
    else await this.store.setPinned(sessionId, pinned);
    this.emit({ type: "catalog-changed", sessionId });
  }

  async updatePreferences(sessionId: string, patch: Partial<SessionPreferences>): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      const current = runtime.snapshot().session.preferences;
      await runtime.updateMetadata({ preferences: { ...current, ...patch } });
    } else {
      const session = await this.store.load(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      await this.store.updatePreferences(sessionId, { ...session.preferences, ...patch });
    }
    this.emit({ type: "catalog-changed", sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) throw new Error("Stop this conversation before archiving it.");
    await runtime?.flush();
    await this.store.setArchived(sessionId, true);
    this.disposeRuntime(sessionId);
    this.emit({ type: "catalog-changed", sessionId });

    await this.rebindViewsAwayFrom(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.store.setArchived(sessionId, false);
    this.emit({ type: "catalog-changed", sessionId });
  }

  async fork(sessionId: string): Promise<PersistedSession> {
    const fork = await this.store.fork(sessionId);
    if (!fork) throw new Error(`Session not found: ${sessionId}`);
    this.emit({ type: "catalog-changed", sessionId: fork.id });
    return fork;
  }

  async delete(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) throw new Error("Stop this conversation before deleting it.");
    this.disposeRuntime(sessionId);
    await this.store.delete(sessionId);
    this.emit({ type: "catalog-changed", sessionId });
    await this.rebindViewsAwayFrom(sessionId);
  }

  /**
   * Emergency recovery: force this session's live runtime to re-read its
   * body from disk, discarding in-memory chatHistory/agentMessages/draft in
   * favor of whatever is actually on disk right now. See
   * SessionRuntime.reloadFromDisk for the full recovery workflow this
   * restores (hand-edit an oversized session body, then reload without
   * restarting Obsidian).
   *
   * Ensures a runtime exists first: if this session had no hydrated runtime
   * at all, ensureRuntime() already hydrates it via a genuine disk read, so
   * reloadFromDisk() on the resulting runtime is a (harmless, idempotent)
   * second read that also resyncs the catalog to match the file on disk.
   *
   * Throws (does not silently no-op) if the session is currently running a
   * turn — callers should surface that to the user rather than swallow it.
   */
  async reloadFromDisk(sessionId: string): Promise<SessionRuntimeSnapshot> {
    const runtime = await this.ensureRuntime(sessionId);
    await runtime.reloadFromDisk();
    this.emit({ type: "catalog-changed", sessionId });
    return runtime.snapshot();
  }

  async setDraftForView(viewId: string, text: string, contextRefs: SessionRuntimeSnapshot["session"]["draft"]["contextRefs"]): Promise<void> {
    const id = this.viewBindings.get(viewId);
    if (!id) return;
    const runtime = await this.ensureRuntime(id);
    await runtime.setDraft(text, contextRefs);
  }

  /** Called from plugin onunload. Running work cannot survive Obsidian shutdown. */
  async shutdown(): Promise<void> {
    for (const queued of this.queue.splice(0)) {
      this.runtimes.get(queued.sessionId)?.cancelQueued();
      queued.resolve();
    }
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map(async (runtime) => {
      if (runtime.isBusy) await runtime.stop();
      await runtime.flush();
    }));
  }

  private async startRuntime(runtime: SessionRuntime, request: SessionRunRequest): Promise<void> {
    this.runningCount++;
    try {
      await runtime.run(request);
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.drainQueue();
      void this.evictIdleRuntimes();
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

  private async ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const session = await this.store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const agent = this.agentFactory.create(session);
    const runtime = new SessionRuntime({
      session,
      agent,
      persist: async (state) => {
        try {
          const saved = await this.store.save(state, { expectRevision: state.revision });
          this.emit({ type: "catalog-changed", sessionId: saved.id });
          return saved;
        } catch (error) {
          if (error instanceof SessionConflictError) this.onStoreConflict?.(error);
          throw error;
        }
      },
      reloadFromDisk: (id) => this.store.reloadFromDisk(id),
      onTerminal: (finished, outcome) => { void this.handleTerminal(finished, outcome); },
    });
    this.runtimes.set(sessionId, runtime);
    const unsubscribe = runtime.subscribe((event) => {
      this.emit({ type: "runtime-event", sessionId, event });
    });
    this.runtimeUnsubscribers.set(sessionId, unsubscribe);
    await this.evictIdleRuntimes();
    return runtime;
  }

  private async handleTerminal(runtime: SessionRuntime, outcome: SessionRunOutcome): Promise<void> {
    const visible = this.isSessionVisible(runtime.id);
    if (!visible) {
      await runtime.markUnread();
      const summary = await this.store.getSummary(runtime.id);
      if (summary) this.onBackgroundCompletion?.(summary, outcome);
    }
  }

  private isSessionVisible(sessionId: string): boolean {
    for (const viewId of this.visibleViews) {
      if (this.viewBindings.get(viewId) === sessionId) return true;
    }
    return false;
  }

  private async evictIdleRuntimes(): Promise<void> {
    if (this.runtimes.size <= this.maxHydratedRuntimes) return;
    const protectedIds = new Set(this.viewBindings.values());
    const candidates = [...this.runtimes.values()]
      .filter((runtime) => runtime.canEvict && !protectedIds.has(runtime.id))
      .sort((a, b) => a.touchedAt - b.touchedAt);
    while (this.runtimes.size > this.maxHydratedRuntimes && candidates.length > 0) {
      const runtime = candidates.shift()!;
      await runtime.flush();
      this.disposeRuntime(runtime.id);
    }
  }

  private disposeRuntime(sessionId: string): void {
    this.runtimeUnsubscribers.get(sessionId)?.();
    this.runtimeUnsubscribers.delete(sessionId);
    this.runtimes.delete(sessionId);
  }

  private emit(event: SessionManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async rebindViewsAwayFrom(sessionId: string): Promise<void> {
    const affected = [...this.viewBindings].filter(([, bound]) => bound === sessionId);
    if (affected.length === 0) return;
    const fallback = await this.createSession();
    for (const [viewId] of affected) {
      this.viewBindings.set(viewId, fallback.id);
      this.emit({ type: "view-binding", viewId, sessionId: fallback.id });
    }
  }

  private async assertNotArchivedMutation(sessionId: string, allowArchived: boolean): Promise<void> {
    if (allowArchived) return;
    const summary = await this.store.getSummary(sessionId);
    if (summary?.isArchived) throw new Error("Unarchive this conversation before editing it.");
  }
}

export function preferencesFromSettings(settings: ChatSettings): SessionPreferences {
  return {
    provider: settings.provider,
    model: settings.model,
    profileId: (settings as ChatSettings & { activePromptProfileId?: string }).activePromptProfileId,
    effortOverride: (settings as ChatSettings & { reasoningEffort?: SessionPreferences["effortOverride"] }).reasoningEffort,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
