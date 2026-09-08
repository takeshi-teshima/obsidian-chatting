import type {
  ConversationModelRecoverySource,
  SessionMetadata,
  UsageInfo,
} from "./types";

export interface SessionMetadataDecodeResult {
  metadata: SessionMetadata;
  /** True when a Claudian-supported legacy alias was normalized. */
  needsMigration: boolean;
  /** Unknown fields are retained so a newer Claudian field is not destroyed. */
  unknownFields: Record<string, unknown>;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSessionMetadataId(id: string): boolean {
  return (
    SAFE_ID.test(id)
    && id !== "."
    && id !== ".."
    && !/%(?:2f|5c)/i.test(id)
  );
}

export function assertValidSessionMetadataId(id: string): void {
  if (!isValidSessionMetadataId(id)) {
    throw new Error(`Invalid session metadata id: ${JSON.stringify(id)}`);
  }
}

/**
 * Decode with the same broad migration posture used by current Claudian:
 * - lastActivityAt falls back to lastResponseAt / updatedAt / createdAt
 * - currentNote is accepted as a legacy linkedContentPath alias
 * - unknown top-level fields are preserved for forward compatibility
 */
export function decodeSessionMetadata(
  input: unknown,
  expectedId?: string,
): SessionMetadataDecodeResult | null {
  if (!isRecord(input)) return null;
  if (typeof input.id !== "string" || !isValidSessionMetadataId(input.id)) return null;
  if (expectedId !== undefined && input.id !== expectedId) return null;
  if (typeof input.title !== "string") return null;
  if (!isFiniteNumber(input.createdAt)) return null;

  const lastActivityAt = firstFinite(
    input.lastActivityAt,
    input.lastResponseAt,
    input.updatedAt,
    input.createdAt,
  );
  if (lastActivityAt === undefined) return null;

  const providerId = optionalString(input.providerId);
  const sessionId = input.sessionId === null ? null : optionalString(input.sessionId);
  const selectedModel = optionalString(input.selectedModel);
  const providerState = optionalRecord(input.providerState);
  const modelRecoverySource = parseModelRecoverySource(input.modelRecoverySource);
  const linkedContentPath = firstString(input.linkedContentPath, input.currentNote);
  const titleGenerationStatus = parseTitleStatus(input.titleGenerationStatus);
  const externalContextPaths = parseStringArray(input.externalContextPaths);
  const usage = parseUsageInfo(input.usage);
  const resumeAtMessageId = optionalString(input.resumeAtMessageId);

  if (input.providerId !== undefined && providerId === undefined) return null;
  if (input.sessionId !== undefined && input.sessionId !== null && sessionId === undefined) return null;
  if (input.selectedModel !== undefined && selectedModel === undefined) return null;
  if (input.providerState !== undefined && providerState === undefined) return null;
  if (input.modelRecoverySource !== undefined && modelRecoverySource === undefined) return null;
  if (input.titleGenerationStatus !== undefined && titleGenerationStatus === undefined) return null;
  if (input.externalContextPaths !== undefined && externalContextPaths === undefined) return null;
  if (input.usage !== undefined && usage === undefined) return null;
  if (input.resumeAtMessageId !== undefined && resumeAtMessageId === undefined) return null;
  if (input.isPinned !== undefined && typeof input.isPinned !== "boolean") return null;
  if (input.isArchived !== undefined && typeof input.isArchived !== "boolean") return null;

  const metadata: SessionMetadata = {
    id: input.id,
    title: input.title,
    createdAt: input.createdAt,
    lastActivityAt,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(titleGenerationStatus !== undefined ? { titleGenerationStatus } : {}),
    ...(input.sessionId === null ? { sessionId: null } : sessionId !== undefined ? { sessionId } : {}),
    ...(selectedModel !== undefined ? { selectedModel } : {}),
    ...(providerState !== undefined ? { providerState } : {}),
    ...(modelRecoverySource !== undefined ? { modelRecoverySource } : {}),
    ...(linkedContentPath !== undefined ? { linkedContentPath } : {}),
    ...(typeof input.isPinned === "boolean" ? { isPinned: input.isPinned } : {}),
    ...(typeof input.isArchived === "boolean" ? { isArchived: input.isArchived } : {}),
    ...(externalContextPaths !== undefined ? { externalContextPaths } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(resumeAtMessageId !== undefined ? { resumeAtMessageId } : {}),
  };

  const known = new Set([
    "id",
    "providerId",
    "title",
    "titleGenerationStatus",
    "createdAt",
    "lastActivityAt",
    "lastResponseAt",
    "updatedAt",
    "sessionId",
    "selectedModel",
    "providerState",
    "modelRecoverySource",
    "linkedContentPath",
    "currentNote",
    "isPinned",
    "isArchived",
    "externalContextPaths",
    "usage",
    "resumeAtMessageId",
  ]);
  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!known.has(key)) unknownFields[key] = value;
  }

  return {
    metadata,
    unknownFields,
    needsMigration: (
      !isFiniteNumber(input.lastActivityAt)
      || "updatedAt" in input
      || "lastResponseAt" in input
      || (typeof input.currentNote === "string" && typeof input.linkedContentPath !== "string")
    ),
  };
}

/**
 * Current write path is identity-shaped Claudian metadata, not a projection.
 * Unknown fields from a newer upstream metadata document are round-tripped.
 */
export function encodeSessionMetadata(
  metadata: SessionMetadata,
  unknownFields: Record<string, unknown> = {},
): Record<string, unknown> {
  assertValidSessionMetadataId(metadata.id);
  return {
    ...unknownFields,
    ...metadata,
  };
}

function parseModelRecoverySource(value: unknown): ConversationModelRecoverySource | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (typeof value.sessionId !== "string" && value.sessionId !== null) return undefined;
  const providerState = optionalRecord(value.providerState);
  if (value.providerState !== undefined && providerState === undefined) return undefined;
  const resumeAtMessageId = optionalString(value.resumeAtMessageId);
  if (value.resumeAtMessageId !== undefined && resumeAtMessageId === undefined) return undefined;
  return {
    sessionId: value.sessionId,
    ...(providerState !== undefined ? { providerState } : {}),
    ...(resumeAtMessageId !== undefined ? { resumeAtMessageId } : {}),
  };
}

function parseUsageInfo(value: unknown): UsageInfo | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (
    !isFiniteNumber(value.inputTokens)
    || !isFiniteNumber(value.contextWindow)
    || !isFiniteNumber(value.contextTokens)
    || !isFiniteNumber(value.percentage)
  ) return undefined;
  if (value.model !== undefined && typeof value.model !== "string") return undefined;
  if (value.cacheCreationInputTokens !== undefined && !isFiniteNumber(value.cacheCreationInputTokens)) return undefined;
  if (value.cacheReadInputTokens !== undefined && !isFiniteNumber(value.cacheReadInputTokens)) return undefined;
  if (value.contextWindowIsAuthoritative !== undefined && typeof value.contextWindowIsAuthoritative !== "boolean") return undefined;
  return {
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    inputTokens: value.inputTokens,
    ...(isFiniteNumber(value.cacheCreationInputTokens) ? { cacheCreationInputTokens: value.cacheCreationInputTokens } : {}),
    ...(isFiniteNumber(value.cacheReadInputTokens) ? { cacheReadInputTokens: value.cacheReadInputTokens } : {}),
    contextWindow: value.contextWindow,
    ...(typeof value.contextWindowIsAuthoritative === "boolean" ? { contextWindowIsAuthoritative: value.contextWindowIsAuthoritative } : {}),
    contextTokens: value.contextTokens,
    percentage: value.percentage,
  };
}

function parseTitleStatus(value: unknown): "pending" | "success" | "failed" | undefined {
  return value === "pending" || value === "success" || value === "failed" ? value : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return [...value];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstFinite(...values: unknown[]): number | undefined {
  return values.find(isFiniteNumber);
}
