import type { SessionMetadata } from "../metadata/types";
import { applyNextTurnSelection, resolveNextTurnExecution, type TurnSelectionFallback } from "../../turn-execution/selection";
import type { TurnExecutionConfig } from "../../turn-execution/types";
import type { UnifiedMessage } from "../../types";
import type { SessionWorkspaceStore, CreateSessionInput } from "../store";
import { SessionRuntime, type SessionAgentAdapter } from "./runtime";
import type {
  SessionQuery,
  SessionQueryResult,
  SessionRunOutcome,
  SessionRunRequest,
  SessionSendRequest,
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
  /**
   * Resolves provider/model/reasoning for a legacy session missing one or
   * more of `selectedModel` / `providerState.upstreamProvider` /
   * `providerState.reasoningEffort`. Never used to override an explicit
   * per-session selection that is already present.
   */
  getTurnSelectionFallback: (metadata: SessionMetadata) => TurnSelectionFallback;
  /** Recommended: 2 on narrow/mobile, 3-4 on desktop. */
  maxConcurrentRuns?: number;
  /** Recommended: 6-10 hydrated idle runtimes. */
  maxHydratedRuntimes?: number;
  onBackgroundCompletion?: (sessionId: string, outcome: SessionRunOutcome) => void;
  /**
   * Fired after an automatic reload-on-open attempt (see
   * `ensureRuntimeForOpen`, used by `bindView`/`switchView` when re-attaching
   * to an already-hydrated, idle session — the automatic replacement for the
   * old manual "Reload from disk" button). `{ changed }` reports whether the
   * reloaded message count actually differs from what was in memory, so
   * callers can choose to notify the user only on a genuine external edit
   * rather than on every routine session switch. `{ error }` reports that the
   * reload attempt itself failed (e.g. corrupt/missing file); this should
   * always surface to the user since it can otherwise leave them looking at
   * silently stale state.
   */
  onAutoReload?: (sessionId: string, result: { changed: boolean } | { error: unknown }) => void;
  /**
   * Injected LLM call for auto-generating a conversation title (Claudian
   * parity). Deliberately the ONLY point of contact with `src/api/*` — this
   * keeps SessionManager free of concrete provider imports, matching the
   * same DI pattern as `agentFactory`/`getTurnSelectionFallback`. Wired from
   * `src/main.ts` using `sendMessage()` (src/api/client.ts). See `run()` for
   * the automatic trigger and `regenerateTitle()` for the explicit one.
   */
  generateTitle?: (input: {
    sessionId: string;
    metadata: SessionMetadata;
    /**
     * A text-only digest of the WHOLE conversation so far (see
     * `buildConversationDigest()` below) — not just the first exchange.
     * `regenerateTitle()` can be called well into a long conversation, at
     * which point a title based only on message #1 would ignore
     * everything the conversation has since turned into.
     */
    conversationText: string;
  }) => Promise<string>;
  /**
   * Live gate for the AUTOMATIC (post-first-turn) title generation trigger
   * only — read fresh on every admission, not captured once at construction,
   * so toggling the setting takes effect without a plugin reload. Defaults
   * to always-enabled when absent. `regenerateTitle()` (explicit user
   * action) intentionally bypasses this gate.
   */
  isTitleGenerationEnabled?: () => boolean;
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
  private readonly getTurnSelectionFallback: SessionManagerOptions["getTurnSelectionFallback"];
  private readonly maxConcurrentRuns: number;
  private readonly maxHydratedRuntimes: number;
  private readonly onBackgroundCompletion?: SessionManagerOptions["onBackgroundCompletion"];
  private readonly onAutoReload?: SessionManagerOptions["onAutoReload"];
  private readonly generateTitle?: SessionManagerOptions["generateTitle"];
  private readonly isTitleGenerationEnabled: () => boolean;

  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly runtimeUnsubscribers = new Map<string, () => void>();
  private readonly viewBindings = new Map<string, string>();
  private readonly visibleViews = new Set<string>();
  private readonly listeners = new Set<(event: SessionManagerEvent) => void>();
  private readonly queue: QueuedRun[] = [];
  private runningCount = 0;
  /**
   * Admission-time eligibility snapshot for the automatic title-generation
   * trigger, keyed by sessionId. Populated in `run()` BEFORE the turn
   * starts and consumed in `handleTerminal()` after it finishes.
   *
   * This must be decided pre-turn, not post-turn: `SessionWorkspaceStore
   * .saveHistoryAndActivity()` already applies its own crude "first user
   * message, truncated" heuristic title to any session still titled "New
   * chat" as soon as the FIRST mid-turn checkpoint lands (see
   * `SessionRuntime.checkpointMessages()`, fired from the `onResponse`/
   * `onToolResult` callbacks) — i.e. well before this turn's `run()` call
   * resolves. If eligibility were (re)checked after the turn completes, a
   * normal successful turn would almost never see `title === "New chat"`
   * anymore and LLM title generation would never fire. Capturing the
   * pristine-ness up front sidesteps that race; the LLM-generated title (if
   * it succeeds) simply overwrites whatever heuristic title landed
   * mid-turn.
   */
  private readonly titleGenerationEligible = new Map<string, boolean>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.agentFactory = options.agentFactory;
    this.getDefaultSessionSeed = options.getDefaultSessionSeed;
    this.getTurnSelectionFallback = options.getTurnSelectionFallback;
    this.maxConcurrentRuns = clamp(options.maxConcurrentRuns ?? 3, 1, 6);
    this.maxHydratedRuntimes = clamp(options.maxHydratedRuntimes ?? 8, 2, 24);
    this.onBackgroundCompletion = options.onBackgroundCompletion;
    this.onAutoReload = options.onAutoReload;
    this.generateTitle = options.generateTitle;
    this.isTitleGenerationEnabled = options.isTitleGenerationEnabled ?? (() => true);
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
    const runtime = await this.ensureRuntimeForOpen(sessionId);
    await runtime.markRead();
    this.emit({ type: "view-binding", viewId, sessionId });
    return runtime.snapshot();
  }

  async switchView(viewId: string, sessionId: string): Promise<SessionRuntimeSnapshot> {
    if (!(await this.store.getMeta(sessionId))) throw new Error(`Session not found: ${sessionId}`);
    this.viewBindings.set(viewId, sessionId);
    const runtime = await this.ensureRuntimeForOpen(sessionId);
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

  async runForView(viewId: string, request: SessionSendRequest): Promise<void> {
    const id = this.viewBindings.get(viewId);
    if (!id) throw new Error(`View ${viewId} is not bound to a session.`);
    return this.run(id, request);
  }

  async run(sessionId: string, request: SessionSendRequest): Promise<void> {
    const meta = await this.store.getMeta(sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);
    if (meta.isArchived) throw new Error("Unarchive this conversation before sending.");
    const runtime = await this.ensureRuntime(sessionId);
    if (runtime.status !== "idle") throw new Error(`Session is already ${runtime.status}.`);

    // Admission snapshot: captured NOW, at Send, from the session's current
    // next-turn selection. Any selector change made after this point (while
    // this turn runs or waits in the global concurrency queue) affects only
    // a LATER send, never this one. See SEMANTICS.md invariants 6-9.
    const metadata = runtime.snapshot().metadata;
    const admitted: SessionRunRequest = {
      ...request,
      execution: request.execution ?? resolveNextTurnExecution(
        metadata,
        this.getTurnSelectionFallback(metadata),
      ),
    };

    if (this.generateTitle) {
      this.titleGenerationEligible.set(
        sessionId,
        this.isTitleGenerationEnabled() && isTitleGenerationEligible(metadata),
      );
    }

    if (this.runningCount >= this.maxConcurrentRuns) {
      runtime.setQueued();
      return new Promise<void>((resolve, reject) => {
        this.queue.push({ sessionId, request: admitted, resolve, reject });
      });
    }
    return this.startRuntime(runtime, admitted);
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

  /**
   * Explicit user-triggered re-run of title generation (command +
   * session-switcher-modal menu item). Unlike the automatic post-first-turn
   * trigger in `run()`/`handleTerminal()`, this bypasses BOTH the "still
   * titled 'New chat'" guard and the `titleGenerationEnabled` setting gate —
   * an explicit request always attempts generation, overwriting whatever
   * title/status is currently there.
   */
  async regenerateTitle(sessionId: string): Promise<void> {
    if (!this.generateTitle) throw new Error("Title generation is not configured.");
    await this.runTitleGeneration(sessionId);
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) await this.store.setPinned(sessionId, pinned);
    else if (runtime) await runtime.updateMetadata((metadata) => ({ ...metadata, isPinned: pinned }));
    else await this.store.setPinned(sessionId, pinned);
    this.emit({ type: "catalog-changed", sessionId });
  }

  /**
   * Change the configuration for the NEXT send. Intentionally allowed while
   * the current turn is running or queued: the active/queued request already
   * owns its own immutable TurnExecutionConfig snapshot captured at
   * admission time (see run() above), so this can never retroactively change
   * an in-flight turn.
   *
   * Claudian parity (branch 14): a still-pristine conversation
   * (`ConversationMeta.messageCount === 0` — no canonical message has been
   * persisted yet) may switch upstream provider through this control; once
   * any message exists, cross-provider selection is rejected by
   * applyNextTurnSelection() without corrupting session state. This is
   * computed here, from the derived index's messageCount, rather than
   * accepted from the caller, so no UI layer can bypass the rule.
   */
  async setNextTurnSelection(
    sessionId: string,
    selection: TurnExecutionConfig,
  ): Promise<void> {
    const meta = await this.store.getMeta(sessionId);
    const allowProviderSwitch = (meta?.messageCount ?? 0) === 0;
    const next = await this.store.updateMetadata(
      sessionId,
      (metadata) => applyNextTurnSelection(metadata, selection, { allowProviderSwitch }),
    );
    if (!next) throw new Error(`Session not found: ${sessionId}`);
    this.runtimes.get(sessionId)?.adoptMetadata(next);
    this.emit({ type: "catalog-changed", sessionId });
  }

  /** Backward-compatible model-only entry point; keeps the session's current provider/reasoning. */
  async setSelectedModel(sessionId: string, model: string): Promise<void> {
    const runtime = await this.ensureRuntime(sessionId);
    const metadata = runtime.snapshot().metadata;
    const current = resolveNextTurnExecution(metadata, this.getTurnSelectionFallback(metadata));
    await this.setNextTurnSelection(sessionId, { ...current, model });
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

  /**
   * `bindView`/`switchView`-only entry point: transparently reloads an
   * already-hydrated, idle session's history fresh from disk before handing
   * it back — the automatic replacement for the old manual "Reload from
   * disk" button, now triggered by opening/switching to a session instead of
   * a click. Deliberately checks `this.runtimes.has(sessionId)` directly
   * (rather than changing `ensureRuntime`'s signature/other call sites, e.g.
   * `run()`'s turn admission or `subscribeView`) so this stays scoped to the
   * two "opening a session" call sites and can't accidentally trigger a
   * reload from an unrelated internal path.
   *
   * - Not yet hydrated this Obsidian session: delegates straight to
   *   `ensureRuntime`, whose `store.load()` is already a fresh disk read, so
   *   no second read is performed.
   * - Hydrated but BUSY (mid-turn): returns the live runtime unreloaded —
   *   never corrupts an in-progress turn.
   * - Hydrated and idle: reloads via the existing `reloadFromDisk` recovery
   *   primitive. On success, reports whether the message count actually
   *   changed via `onAutoReload`. On failure (e.g. corrupt/missing file),
   *   `reloadFromDisk` has already discarded the old runtime, so this falls
   *   back to a fresh `ensureRuntime` attempt (retrying the disk read) and
   *   reports the error via `onAutoReload` so it isn't silently swallowed.
   */
  private async ensureRuntimeForOpen(sessionId: string): Promise<SessionRuntime> {
    const wasHydrated = this.runtimes.has(sessionId);
    if (!wasHydrated) return this.ensureRuntime(sessionId);

    const existing = this.runtimes.get(sessionId)!;
    if (existing.isBusy) return existing;

    const beforeCount = existing.snapshot().messages.length;
    try {
      await this.reloadFromDisk(sessionId);
    } catch (error) {
      this.onAutoReload?.(sessionId, { error });
      return this.ensureRuntime(sessionId);
    }
    const runtime = this.runtimes.get(sessionId)!;
    const afterCount = runtime.snapshot().messages.length;
    this.onAutoReload?.(sessionId, { changed: afterCount !== beforeCount });
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

    // Fire-and-forget: must never delay this handler (which is itself
    // already fire-and-forget from SessionRuntime.finish()) or affect the
    // SessionRunOutcome already reported to the caller of run().
    const eligible = this.titleGenerationEligible.get(runtime.id) ?? false;
    this.titleGenerationEligible.delete(runtime.id);
    if (outcome === "completed" && eligible && this.generateTitle) {
      void this.runTitleGeneration(runtime.id).catch((error) => {
        console.error(`[chatting-with-ai] title generation failed for session ${runtime.id}`, error);
      });
    }

    this.emit({ type: "catalog-changed", sessionId: runtime.id });
  }

  /**
   * Shared implementation for both the automatic post-first-turn trigger and
   * the explicit `regenerateTitle()` command/menu path. Never throws: a
   * title-generation failure is caught, recorded as
   * `titleGenerationStatus: "failed"`, and otherwise swallowed — it must
   * never surface as a turn error to the user.
   */
  private async runTitleGeneration(sessionId: string): Promise<void> {
    if (!this.generateTitle) return;
    const workspace = await this.store.load(sessionId);
    if (!workspace) return;

    const conversationText = buildConversationDigest(workspace.messages);
    await this.patchMetadata(sessionId, (metadata) => ({ ...metadata, titleGenerationStatus: "pending" }));

    try {
      const raw = await this.generateTitle({
        sessionId,
        metadata: workspace.metadata,
        conversationText,
      });
      const title = sanitizeGeneratedTitle(raw);
      if (!title) throw new Error("Title generation returned an empty response.");
      await this.patchMetadata(sessionId, (metadata) => ({
        ...metadata,
        title,
        titleGenerationStatus: "success",
      }));
    } catch (error) {
      console.error(`[chatting-with-ai] title generation failed for session ${sessionId}`, error);
      await this.patchMetadata(sessionId, (metadata) => ({ ...metadata, titleGenerationStatus: "failed" }));
    }
  }

  /**
   * Same busy/hydrated-idle/not-hydrated dispatch as `rename()` (see its
   * comment above) — extracted here rather than reused by `rename()` itself
   * so `rename()`'s existing behavior stays byte-for-byte unchanged.
   */
  private async patchMetadata(
    sessionId: string,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isBusy) {
      await this.store.updateMetadata(sessionId, updater);
    } else if (runtime) {
      await runtime.updateMetadata(updater);
    } else {
      await this.store.updateMetadata(sessionId, updater);
    }
    this.emit({ type: "catalog-changed", sessionId });
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

/** Pre-turn admission check: still the untouched default, and no generation already in flight/done. */
function isTitleGenerationEligible(metadata: SessionMetadata): boolean {
  return (
    metadata.title === "New chat" &&
    metadata.titleGenerationStatus !== "pending" &&
    metadata.titleGenerationStatus !== "success"
  );
}

const GENERATED_TITLE_MAX_LENGTH = 60;
// Overall cap on the digest handed to the title-generation LLM call. Kept
// modest since this is a cheap one-shot call, not the actual agent turn.
const DIGEST_TOTAL_LIMIT = 6000;
// When the digest would exceed the cap, keep this many chars from the START
// (topic-setting) and fill the rest of the budget from the END (where the
// conversation has most recently moved to) rather than just truncating the
// tail — a title generated well into a long conversation should reflect
// both where it started and where it's ended up, not just message #1.
const DIGEST_HEAD_SHARE = 0.4;

/**
 * Text-only digest of the ENTIRE conversation so far (user + assistant
 * turns only — tool calls/results are omitted, they're not useful title
 * material and can be large). Replaces an earlier version that only ever
 * looked at the very first user/assistant message: fine for the automatic
 * post-first-turn trigger (nothing else exists yet at that point anyway),
 * but wrong for `regenerateTitle()`, which can be invoked well into a long
 * conversation and was still silently generating a title from message #1
 * alone, ignoring everything since.
 */
function buildConversationDigest(messages: readonly UnifiedMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOfMessage(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
  }

  const full = lines.join("\n");
  if (full.length <= DIGEST_TOTAL_LIMIT) return full;

  const headLen = Math.floor(DIGEST_TOTAL_LIMIT * DIGEST_HEAD_SHARE);
  const tailLen = DIGEST_TOTAL_LIMIT - headLen;
  const head = full.slice(0, headLen).trimEnd();
  const tail = full.slice(full.length - tailLen).trimStart();
  return `${head}\n... (conversation continues) ...\n${tail}`;
}

function textOfMessage(message: UnifiedMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Trims whitespace, strips surrounding quote characters, and caps length. */
function sanitizeGeneratedTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  if (title.length > GENERATED_TITLE_MAX_LENGTH) {
    title = title.slice(0, GENERATED_TITLE_MAX_LENGTH).trimEnd();
  }
  return title;
}
