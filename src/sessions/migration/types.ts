import type { UnifiedMessage } from "../../types";

export interface MigrationDiagnostic {
  sourceKind: string;
  sourceId: string;
  message: string;
}

export interface MigrationSummary {
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  diagnostics: MigrationDiagnostic[];
  /** Destination ids created/confirmed this run, newest activity first. */
  destinationIds: string[];
}

/**
 * Common denominator of the legacy shapes we migrate from (branch-11
 * PersistedSession and Session Workspaces v3 PersistedSession are structurally
 * identical for migration purposes; legacy single chat-state.json is the
 * degenerate case with no title/preferences/pin/archive state).
 */
export interface LegacySessionLike {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  lastActivityAt?: number;
  provider?: string;
  model?: string;
  profileId?: string;
  effortOverride?: unknown;
  isPinned?: boolean;
  isArchived?: boolean;
  chatHistory?: unknown[];
  agentMessages?: UnifiedMessage[];
}
