import type { ContextRef } from "../context/refs";
import type { UnifiedMessage } from "../types";
import { ChattingHistoryStore } from "./history/store";
import { SessionIndexStore } from "./index/store";
import { toConversationMeta } from "./index/derived-index";
import { SessionLocalStateStore, createDefaultSessionLocalState } from "./local/store";
import { createSessionMetadata } from "./metadata/factory";
import { SessionMetadataStore, type StoredSessionMetadata } from "./metadata/store";
import {
  CHATTING_PROVIDER_ID,
  getChattingProviderState,
  type ChattingProviderState,
  type ConversationMeta,
  type SessionMetadata,
} from "./metadata/types";
import type {
  LoadedSessionWorkspace,
  SessionLocalState,
  SessionQuery,
  SessionQueryResult,
  SessionStoreStats,
} from "./runtime/types";
import { KeyedSerialQueue } from "./runtime/async-lock";

export interface CreateSessionInput {
  title?: string;
  selectedModel?: string;
  upstreamProvider?: string;
  profileId?: string | null;
  reasoningEffort?: string;
  webSearch?: boolean;
}

export interface SessionWorkspaceStoreInitializeResult {
  indexRebuilt: boolean;
  stats: SessionStoreStats;
  /** See `SessionIndexInitializeResult.quarantinedPaths`. Empty on a normal startup. */
  quarantinedIndexPaths: string[];
}

/**
 * Composition facade for canonical Claudian-shaped metadata, Chatting-native
 * JSONL history, and Chatting-only local UI/runtime state.
 */
export class SessionWorkspaceStore {
  private readonly queue = new KeyedSerialQueue();

  constructor(
    readonly metadata: SessionMetadataStore,
    readonly history: ChattingHistoryStore,
    readonly local: SessionLocalStateStore,
    readonly index: SessionIndexStore,
  ) {}

  async initialize(): Promise<SessionWorkspaceStoreInitializeResult> {
    const result = await this.index.initialize(() => this.rebuildIndexSource());
    return { indexRebuilt: result.rebuilt, stats: result.stats, quarantinedIndexPaths: result.quarantinedPaths };
  }

  async create(input: CreateSessionInput = {}): Promise<LoadedSessionWorkspace> {
    const now = Date.now();
    const id = createSessionId(now);
    const historyPath = this.history.pathFor(id);
    const metadata = createSessionMetadata({
      id,
      title: input.title,
      now,
      selectedModel: input.selectedModel,
      upstreamProvider: input.upstreamProvider,
      historyPath,
      profileId: input.profileId,
      reasoningEffort: input.reasoningEffort,
      webSearch: input.webSearch,
    });
    const localState = createDefaultSessionLocalState(id);
    await this.history.replace(id, []);
    await this.metadata.clearDeletionMarker(id);
    await this.metadata.save(metadata);
    await this.local.save(localState);
    await this.index.upsert(toConversationMeta(metadata, { messageCount: 0, preview: "" }), null);
    return { metadata, unknownMetadataFields: {}, messages: [], localState };
  }

  async load(id: string): Promise<LoadedSessionWorkspace | null> {
    if (await this.metadata.isDeleted(id)) return null;
    const stored = await this.metadata.load(id);
    if (!stored) return null;
    if ((stored.metadata.providerId ?? CHATTING_PROVIDER_ID) !== CHATTING_PROVIDER_ID) return null;
    const [messages, localState] = await Promise.all([
      this.history.load(id),
      this.local.load(id),
    ]);
    if (localState.recovery) {
      localState.lastOutcome = "interrupted";
      localState.lastError = localState.lastError ?? "The previous run was interrupted before completion.";
      delete localState.recovery;
      await this.local.save(localState);
    }
    return {
      metadata: stored.metadata,
      unknownMetadataFields: stored.unknownFields,
      messages,
      localState,
    };
  }

  async query(query: SessionQuery): Promise<SessionQueryResult> {
    return this.index.query(query);
  }

  async getStats(): Promise<SessionStoreStats> {
    return this.index.getStats();
  }

  async getMeta(id: string): Promise<ConversationMeta | null> {
    return this.index.get(id);
  }

  async saveWorkspace(workspace: LoadedSessionWorkspace): Promise<LoadedSessionWorkspace> {
    return this.queue.run(workspace.metadata.id, async () => {
      const id = workspace.metadata.id;
      const previous = await this.index.get(id);
      await this.history.replace(id, workspace.messages);
      const metadata = withHistoryRevision(workspace.metadata, workspace.messages.length);
      await this.metadata.save(metadata, workspace.unknownMetadataFields);
      await this.local.save(workspace.localState);
      const next = toConversationMeta(metadata, deriveHistoryDetails(workspace.messages));
      await this.index.upsert(next, previous);
      return { ...workspace, metadata };
    });
  }

  async saveHistoryAndActivity(
    id: string,
    messages: readonly UnifiedMessage[],
    activityAt = Date.now(),
  ): Promise<LoadedSessionWorkspace | null> {
    return this.queue.run(id, async () => {
      const loaded = await this.load(id);
      if (!loaded) return null;
      const previous = await this.index.get(id);
      loaded.messages = [...messages];
      loaded.metadata.lastActivityAt = Math.max(loaded.metadata.lastActivityAt, activityAt);
      loaded.metadata = withHistoryRevision(loaded.metadata, messages.length);
      // Deliberately does NOT auto-derive a title from `messages` here
      // anymore (this used to overwrite a "New chat" title with a crude
      // "first message, truncated" heuristic on every mid-turn checkpoint).
      // Doing it here raced with the real LLM-based title generation
      // SessionManager now owns (see
      // `SessionManager.run()`'s admission-time eligibility snapshot in
      // sessions/runtime/manager.ts): by the time a turn's `run()` call
      // resolved, this heuristic had usually already overwritten
      // `title === "New chat"`, so the proper generator's "still pristine"
      // guard would almost never see a pristine title. Title updates now
      // flow exclusively through SessionManager (this heuristic path, plus
      // the explicit rename()/regenerateTitle() commands).
      await this.history.replace(id, messages);
      await this.metadata.save(loaded.metadata, loaded.unknownMetadataFields);
      await this.local.save(loaded.localState);
      await this.index.upsert(
        toConversationMeta(loaded.metadata, deriveHistoryDetails(messages)),
        previous,
      );
      return loaded;
    });
  }

  async updateMetadata(
    id: string,
    updater: (metadata: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata | null> {
    return this.queue.run(id, async () => {
      const stored = await this.metadata.load(id);
      if (!stored) return null;
      const previous = await this.index.get(id);
      const next = updater(cloneMetadata(stored.metadata));
      if (next.id !== id) throw new Error("Session metadata updater must not change id");
      next.lastActivityAt = Math.max(next.lastActivityAt, stored.metadata.lastActivityAt);
      await this.metadata.save(next, stored.unknownFields);
      const messages = await this.history.load(id);
      await this.index.upsert(toConversationMeta(next, deriveHistoryDetails(messages)), previous);
      return next;
    });
  }

  async rename(id: string, title: string): Promise<SessionMetadata | null> {
    return this.updateMetadata(id, (metadata) => ({
      ...metadata,
      title: title.trim() || metadata.title,
    }));
  }

  async setPinned(id: string, isPinned: boolean): Promise<SessionMetadata | null> {
    return this.updateMetadata(id, (metadata) => ({ ...metadata, isPinned }));
  }

  async setArchived(id: string, isArchived: boolean): Promise<SessionMetadata | null> {
    return this.updateMetadata(id, (metadata) => ({ ...metadata, isArchived }));
  }

  async setSelectedModel(id: string, selectedModel: string): Promise<SessionMetadata | null> {
    return this.updateMetadata(id, (metadata) => ({
      ...metadata,
      selectedModel: selectedModel.trim() || undefined,
    }));
  }

  async updateChattingProviderState(
    id: string,
    patch: Partial<ChattingProviderState>,
  ): Promise<SessionMetadata | null> {
    return this.updateMetadata(id, (metadata) => ({
      ...metadata,
      providerState: {
        ...(metadata.providerState ?? {}),
        ...getChattingProviderState(metadata),
        ...patch,
      },
    }));
  }

  /**
   * Routed through the same per-session KeyedSerialQueue as
   * saveWorkspace/saveHistoryAndActivity. This matters: SessionRuntime calls
   * this directly (unqueued at the runtime level) at the start of every
   * turn, while a *previous* turn's fire-and-forget checkpoint
   * (saveHistoryAndActivity, which also writes local state) may still be
   * draining through this same queue. Without sharing the queue key here,
   * two concurrent writers to the same `.chatting/session-state/<id>.json`
   * file can race in the write-tmp/rename-to-bak/rename-to-final sequence
   * and throw ENOENT.
   */
  async saveLocalState(state: SessionLocalState): Promise<void> {
    await this.queue.run(state.sessionId, async () => {
      await this.local.save(state);
    });
  }

  async fork(id: string): Promise<LoadedSessionWorkspace | null> {
    const source = await this.load(id);
    if (!source) return null;
    const created = await this.create({
      title: `${source.metadata.title} (fork)`,
      selectedModel: source.metadata.selectedModel,
      upstreamProvider: getChattingProviderState(source.metadata).upstreamProvider,
      profileId: getChattingProviderState(source.metadata).profileId,
      reasoningEffort: getChattingProviderState(source.metadata).reasoningEffort,
      webSearch: getChattingProviderState(source.metadata).webSearch,
    });
    created.messages = structuredCloneSafe(source.messages);
    created.metadata.lastActivityAt = Date.now();
    created.localState.draft = { text: "", contextRefs: [] };
    return this.saveWorkspace(created);
  }

  async delete(id: string): Promise<boolean> {
    return this.queue.run(id, async () => {
      const previous = await this.index.get(id);
      const exists = await this.metadata.load(id);
      if (!exists && !previous) return false;
      await this.metadata.markDeleted(id);
      await this.metadata.removeMetadata(id);
      await this.history.remove(id);
      await this.local.remove(id);
      await this.index.remove(id, previous);
      return true;
    });
  }

  async rebuildIndexSource(): Promise<ConversationMeta[]> {
    const stored = await this.metadata.list();
    const out: ConversationMeta[] = [];
    for (const record of stored) {
      if ((record.metadata.providerId ?? CHATTING_PROVIDER_ID) !== CHATTING_PROVIDER_ID) continue;
      if (await this.metadata.isDeleted(record.metadata.id)) continue;
      const messages = await this.history.load(record.metadata.id);
      out.push(toConversationMeta(record.metadata, deriveHistoryDetails(messages)));
    }
    return out;
  }
}

function createSessionId(now = Date.now()): string {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 16);
  return `s_${now.toString(36)}_${random}`;
}

function cloneMetadata(metadata: SessionMetadata): SessionMetadata {
  return {
    ...metadata,
    ...(metadata.providerState ? { providerState: { ...metadata.providerState } } : {}),
    ...(metadata.externalContextPaths ? { externalContextPaths: [...metadata.externalContextPaths] } : {}),
    ...(metadata.usage ? { usage: { ...metadata.usage } } : {}),
  };
}

function withHistoryRevision(metadata: SessionMetadata, messageCount: number): SessionMetadata {
  const state = getChattingProviderState(metadata);
  const currentRevision = state.history?.revision ?? 0;
  return {
    ...metadata,
    providerState: {
      ...(metadata.providerState ?? {}),
      ...state,
      history: {
        format: "unified-message-jsonl",
        schemaVersion: 1,
        path: state.history?.path ?? `.chatting/sessions/${metadata.id}.jsonl`,
        revision: Math.max(currentRevision + 1, messageCount),
      },
    },
  };
}

export function deriveHistoryDetails(messages: readonly UnifiedMessage[]): { messageCount: number; preview: string } {
  return { messageCount: messages.length, preview: derivePreview(messages) };
}

function derivePreview(messages: readonly UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOfMessage(messages[i]).replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
  }
  return "";
}

function textOfMessage(message: UnifiedMessage): string {
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string" && (record.type === "text" || record.type === "input_text" || record.type === "output_text")) return record.content;
    return "";
  }).filter(Boolean).join("\n");
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
