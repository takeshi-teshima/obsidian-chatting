import type { UnifiedMessage } from "../../types";
import { SessionMetadataStore } from "../metadata/store";
import { ChattingHistoryStore } from "../history/store";
import { SessionIndexStore } from "../index/store";
import { createSessionMetadata } from "../metadata/factory";
import { isValidSessionMetadataId } from "../metadata/codec";
import { toConversationMeta } from "../index/derived-index";
import type { MigrationJournal, MigrationSourceKind } from "./journal";
import { MigrationJournalStore } from "./journal";
import type { LegacySessionLike, MigrationDiagnostic } from "./types";
import { normalizeLegacyReasoningEffort } from "./reasoning-effort";
import { isUnifiedMessageShape } from "../history/store";

export interface ImportLegacySessionDeps {
  metadataStore: SessionMetadataStore;
  historyStore: ChattingHistoryStore;
  indexStore: SessionIndexStore;
  journalStore: MigrationJournalStore;
}

export interface ImportLegacySessionResult {
  status: "migrated" | "skipped" | "failed";
  destinationId?: string;
  diagnostics: MigrationDiagnostic[];
}

/**
 * Runs the full per-conversation transaction from MIGRATION_HANDOFF.md §8:
 *
 *   1. validate source (caller's responsibility before calling this)
 *   2. decide/preserve destination id
 *   3. write .jsonl
 *   4. read it back and validate
 *   5. write .meta.json
 *   6. read/decode metadata back
 *   7. update derived index
 *   8. only then mark the source migrated
 *
 * A failure at any step returns "failed" without touching the journal, so a
 * retried run will attempt this source again. The legacy source file itself
 * is never written to by this function.
 */
export async function importLegacySession(
  deps: ImportLegacySessionDeps,
  kind: MigrationSourceKind,
  sourcePath: string,
  source: LegacySessionLike,
  journal: MigrationJournal,
): Promise<{ result: ImportLegacySessionResult; journal: MigrationJournal }> {
  const diagnostics: MigrationDiagnostic[] = [];
  const sourceId = source.id;

  // Idempotency: journal already has this exact (kind, sourceId) as migrated.
  if (deps.journalStore.hasMigrated(journal, kind, sourceId)) {
    const existingEntry = journal.sources.find((s) => s.kind === kind && s.sourceId === sourceId);
    const destinationId = existingEntry?.destinationId ?? sourceId;
    if (await deps.metadataStore.load(destinationId)) {
      return { result: { status: "skipped", destinationId, diagnostics }, journal };
    }
    // Journal says migrated but destination metadata is gone (e.g. user
    // deleted it) — fall through and re-migrate rather than silently no-op.
  }

  // Step 2: decide/preserve destination id.
  let destinationId = isValidSessionMetadataId(sourceId) ? sourceId : mintSafeId(sourceId);
  const existing = await deps.metadataStore.load(destinationId);
  if (existing) {
    const sameSourceAlreadyMigrated = journal.sources.some(
      (s) => s.destinationId === destinationId && s.kind === kind && s.sourceId === sourceId && s.status === "migrated",
    );
    if (sameSourceAlreadyMigrated) {
      return { result: { status: "skipped", destinationId, diagnostics }, journal };
    }
    // A different logical session already occupies this id: never overwrite
    // blindly. Mint a fresh id and record the collision.
    const collidedId = destinationId;
    destinationId = mintSafeId(`${sourceId}-${Date.now().toString(36)}`);
    diagnostics.push({
      sourceKind: kind,
      sourceId,
      message: `Destination id "${collidedId}" already exists with different content; migrated under "${destinationId}" instead.`,
    });
  }

  try {
    // Step 3: build and write the JSONL transcript.
    const { messages, usedFallback } = buildUnifiedMessages(source, diagnostics, kind, sourceId);
    await deps.historyStore.replace(destinationId, messages);

    // Step 4: read back and validate.
    const readBack = await deps.historyStore.load(destinationId);
    if (readBack.length !== messages.length) {
      diagnostics.push({
        sourceKind: kind,
        sourceId,
        message: `History read-back mismatch (wrote ${messages.length}, read ${readBack.length}); aborting this session's migration.`,
      });
      return { result: { status: "failed", diagnostics }, journal };
    }
    if (usedFallback) {
      diagnostics.push({
        sourceKind: kind,
        sourceId,
        message: "agentMessages missing/empty; used a conservative text-only fallback conversion from chatHistory.",
      });
    }

    // Step 5: write metadata.
    const historyPath = deps.historyStore.pathFor(destinationId);
    const effortResult = source.effortOverride !== undefined
      ? normalizeLegacyReasoningEffort(source.effortOverride)
      : undefined;
    if (effortResult && effortResult.effort === undefined) {
      diagnostics.push({
        sourceKind: kind,
        sourceId,
        message: `Unsupported legacy reasoning effort "${effortResult.unsupported}" omitted (not coerced) per migration contract.`,
      });
    }

    const now = Date.now();
    const createdAt = isFiniteNumber(source.createdAt) ? source.createdAt : now;
    const lastActivityAt = firstFinite(source.lastActivityAt, source.updatedAt, createdAt);

    const metadata = createSessionMetadata({
      id: destinationId,
      title: source.title,
      now: createdAt,
      selectedModel: source.model,
      upstreamProvider: source.provider,
      historyPath,
      profileId: source.profileId ?? null,
      reasoningEffort: effortResult?.effort,
    });
    metadata.createdAt = createdAt;
    metadata.lastActivityAt = lastActivityAt;
    if (typeof source.isPinned === "boolean") metadata.isPinned = source.isPinned;
    if (typeof source.isArchived === "boolean") metadata.isArchived = source.isArchived;

    await deps.metadataStore.save(metadata);

    // Step 6: read/decode metadata back.
    const decoded = await deps.metadataStore.load(destinationId);
    if (!decoded) {
      diagnostics.push({
        sourceKind: kind,
        sourceId,
        message: "Metadata read-back/decode failed after write; aborting this session's migration.",
      });
      return { result: { status: "failed", diagnostics }, journal };
    }

    // Step 7: update derived index (real messageCount/preview — we already
    // have the transcript in memory, so no extra hydration cost here).
    const preview = derivePreview(messages, source.chatHistory);
    const title = decoded.metadata.title;
    await deps.indexStore.upsert(
      toConversationMeta(decoded.metadata, { messageCount: messages.length, preview }),
    );
    if (title !== decoded.metadata.title) {
      // no-op; title already comes from decoded.metadata
    }

    // Step 8: only now mark the source migrated.
    const nextJournal = await deps.journalStore.recordAndSave(journal, {
      kind,
      path: sourcePath,
      sourceId,
      destinationId,
      status: "migrated",
      migratedAt: Date.now(),
    });

    return { result: { status: "migrated", destinationId, diagnostics }, journal: nextJournal };
  } catch (error) {
    diagnostics.push({
      sourceKind: kind,
      sourceId,
      message: `Unexpected error migrating session: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { result: { status: "failed", diagnostics }, journal };
  }
}

function buildUnifiedMessages(
  source: LegacySessionLike,
  diagnostics: MigrationDiagnostic[],
  kind: MigrationSourceKind,
  sourceId: string,
): { messages: UnifiedMessage[]; usedFallback: boolean } {
  const agentMessages = Array.isArray(source.agentMessages) ? source.agentMessages : [];
  const validAgentMessages = agentMessages.filter((message) => {
    const ok = isUnifiedMessageShape(message);
    if (!ok) {
      diagnostics.push({
        sourceKind: kind,
        sourceId,
        message: "Skipped one agentMessages entry that does not match the UnifiedMessage contract.",
      });
    }
    return ok;
  });

  if (validAgentMessages.length > 0) {
    // agentMessages is the model-history source of truth: persist verbatim.
    return { messages: validAgentMessages, usedFallback: false };
  }

  // Conservative fallback: only plain user/assistant text from chatHistory.
  // Never synthesize tool_use/tool_result blocks, never inject `error` rows.
  const chatHistory = Array.isArray(source.chatHistory) ? source.chatHistory : [];
  const fallback: UnifiedMessage[] = [];
  for (const entry of chatHistory) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (typeof record.text !== "string" || !record.text.trim()) continue;
    fallback.push({
      role: record.type === "user" ? "user" : "assistant",
      content: record.text,
    });
  }
  return { messages: fallback, usedFallback: fallback.length > 0 };
}

function derivePreview(messages: readonly UnifiedMessage[], chatHistory: unknown[] | undefined): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textOf(messages[i]);
    if (text) return truncate(text, 120);
  }
  if (Array.isArray(chatHistory)) {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const entry = chatHistory[i] as Record<string, unknown> | undefined;
      if (entry && typeof entry.text === "string" && entry.text.trim()) {
        return truncate(entry.text, 120);
      }
    }
  }
  return "";
}

function textOf(message: UnifiedMessage): string {
  if (typeof message.content === "string") return message.content.replace(/\s+/g, " ").trim();
  const block = message.content.find((b) => b.type === "text" && b.text);
  return block?.text?.replace(/\s+/g, " ").trim() ?? "";
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3).trimEnd()}...`;
}

function mintSafeId(seed: string): string {
  const safe = seed.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "s-");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${safe || "s"}-${suffix}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstFinite(...values: unknown[]): number {
  const found = values.find(isFiniteNumber);
  return found ?? Date.now();
}
