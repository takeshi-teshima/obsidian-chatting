import type { LegacyReadAdapter } from "./legacy-adapter";
import type { LegacySessionLike, MigrationDiagnostic } from "./types";

/**
 * Reads Session Workspaces v3's sharded store:
 *
 *   <pluginDataDir>/sessions-v3/data/<2-hex-shard>/<id>.json[.bak]
 *
 * v3 is the primary, most-important migration source for this vault: it is
 * the only store with real, current, non-stale content (see the "CRITICAL:
 * real live data situation" note in the migration task brief). Each session
 * file is validated independently; a corrupt primary falls back to `.bak`,
 * mirroring the recovery order branch-11 already used.
 */
export async function scanV3Sessions(
  adapter: LegacyReadAdapter,
  pluginDataDir: string,
  diagnostics: MigrationDiagnostic[],
): Promise<Array<{ path: string; session: LegacySessionLike }>> {
  const dataDir = `${pluginDataDir}/sessions-v3/data`;
  if (!await adapter.exists(dataDir)) return [];

  const out: Array<{ path: string; session: LegacySessionLike }> = [];
  const { folders } = await adapter.list(dataDir);
  for (const shardDir of folders) {
    const { files } = await adapter.list(shardDir);
    const primaryFiles = files.filter((f) => f.endsWith(".json") && !f.endsWith(".json.bak") && !f.endsWith(".json.tmp"));
    for (const path of primaryFiles) {
      const parsed = await readValidated(adapter, path, diagnostics, "v3-session");
      if (parsed) {
        out.push({ path, session: parsed });
        continue;
      }
      const bakPath = `${path}.bak`;
      if (await adapter.exists(bakPath)) {
        const recovered = await readValidated(adapter, bakPath, diagnostics, "v3-session");
        if (recovered) {
          diagnostics.push({
            sourceKind: "v3-session",
            sourceId: recovered.id,
            message: `Primary session file was invalid; recovered from ${bakPath}.`,
          });
          out.push({ path, session: recovered });
          continue;
        }
      }
      diagnostics.push({
        sourceKind: "v3-session",
        sourceId: path,
        message: `Could not recover a valid session from ${path} (or its .bak); skipping.`,
      });
    }
  }
  return out;
}

async function readValidated(
  adapter: LegacyReadAdapter,
  path: string,
  diagnostics: MigrationDiagnostic[],
  kind: string,
): Promise<LegacySessionLike | null> {
  try {
    const raw = await adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    if (!isV3PersistedSessionShape(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const preferences = (record.preferences ?? {}) as Record<string, unknown>;
    return {
      id: record.id as string,
      title: typeof record.title === "string" ? record.title : undefined,
      createdAt: asNumber(record.createdAt),
      lastActivityAt: asNumber(record.lastActivityAt),
      provider: typeof preferences.provider === "string" ? preferences.provider : undefined,
      model: typeof preferences.model === "string" ? preferences.model : undefined,
      profileId: typeof preferences.profileId === "string" ? preferences.profileId : undefined,
      effortOverride: preferences.effortOverride,
      isPinned: typeof record.isPinned === "boolean" ? record.isPinned : undefined,
      isArchived: typeof record.isArchived === "boolean" ? record.isArchived : undefined,
      chatHistory: Array.isArray(record.chatHistory) ? record.chatHistory : [],
      agentMessages: Array.isArray(record.agentMessages) ? (record.agentMessages as never) : [],
    };
  } catch (error) {
    diagnostics.push({
      sourceKind: kind,
      sourceId: path,
      message: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

function isV3PersistedSessionShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string"
    && record.id.length > 0
    && typeof record.title === "string"
    && (record.chatHistory === undefined || Array.isArray(record.chatHistory))
    && (record.agentMessages === undefined || Array.isArray(record.agentMessages))
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
