import type { LegacyReadAdapter } from "./legacy-adapter";
import type { LegacySessionLike, MigrationDiagnostic } from "./types";

/**
 * Reads the previous branch-11 ("session-persistence") flat store:
 *
 *   <pluginDataDir>/sessions/index.json
 *   <pluginDataDir>/sessions/<id>.json[.bak][.tmp]
 *
 * `index.json` is used only as a discovery hint (per MIGRATION_HANDOFF.md
 * §1.B); every id is still validated independently against its own file, and
 * `.tmp`/`.bak` are never imported as separate conversations — only as
 * recovery sources for a corrupt primary (primary -> .tmp -> .bak).
 */
export async function scanBranch11Sessions(
  adapter: LegacyReadAdapter,
  pluginDataDir: string,
  diagnostics: MigrationDiagnostic[],
): Promise<Array<{ path: string; session: LegacySessionLike }>> {
  const root = `${pluginDataDir}/sessions`;
  if (!await adapter.exists(root)) return [];

  const ids = new Set<string>();
  const indexPath = `${root}/index.json`;
  if (await adapter.exists(indexPath)) {
    try {
      const parsed: unknown = JSON.parse(await adapter.read(indexPath));
      collectIdsFromIndex(parsed).forEach((id) => ids.add(id));
    } catch {
      // index.json is only a hint; fall through to directory listing below.
    }
  }

  const { files } = await adapter.list(root);
  for (const path of files) {
    const name = path.split("/").pop() ?? "";
    if (name === "index.json" || name === "index.json.bak") continue;
    const match = /^(.+)\.json(\.bak|\.tmp)?$/.exec(name);
    if (match) ids.add(match[1]);
  }

  const out: Array<{ path: string; session: LegacySessionLike }> = [];
  for (const id of ids) {
    const primaryPath = `${root}/${id}.json`;
    const tmpPath = `${primaryPath}.tmp`;
    const bakPath = `${primaryPath}.bak`;

    let session = await readValidated(adapter, primaryPath, diagnostics);
    let usedPath = primaryPath;
    if (!session && await adapter.exists(tmpPath)) {
      session = await readValidated(adapter, tmpPath, diagnostics);
      usedPath = tmpPath;
    }
    if (!session && await adapter.exists(bakPath)) {
      session = await readValidated(adapter, bakPath, diagnostics);
      usedPath = bakPath;
    }
    if (!session) {
      diagnostics.push({
        sourceKind: "branch11-session",
        sourceId: id,
        message: `Could not recover a valid session "${id}" from primary/.tmp/.bak; skipping.`,
      });
      continue;
    }
    if (usedPath !== primaryPath) {
      diagnostics.push({
        sourceKind: "branch11-session",
        sourceId: id,
        message: `Primary session file was invalid; recovered from ${usedPath}.`,
      });
    }
    out.push({ path: primaryPath, session });
  }
  return out;
}

function collectIdsFromIndex(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : (entry as { id?: unknown })?.id))
      .filter((id): id is string => typeof id === "string");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.sessions)) return collectIdsFromIndex(record.sessions);
    if (Array.isArray(record.ids)) return collectIdsFromIndex(record.ids);
  }
  return [];
}

async function readValidated(
  adapter: LegacyReadAdapter,
  path: string,
  diagnostics: MigrationDiagnostic[],
): Promise<LegacySessionLike | null> {
  try {
    const raw = await adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    if (!isBranch11PersistedSessionShape(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      id: record.id as string,
      title: typeof record.title === "string" ? record.title : undefined,
      createdAt: asNumber(record.createdAt),
      updatedAt: asNumber(record.updatedAt),
      profileId: typeof record.profileId === "string" ? record.profileId : undefined,
      effortOverride: record.effortOverride,
      chatHistory: Array.isArray(record.chatHistory) ? record.chatHistory : [],
      agentMessages: Array.isArray(record.agentMessages) ? (record.agentMessages as never) : [],
    };
  } catch (error) {
    diagnostics.push({
      sourceKind: "branch11-session",
      sourceId: path,
      message: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

function isBranch11PersistedSessionShape(value: unknown): boolean {
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
