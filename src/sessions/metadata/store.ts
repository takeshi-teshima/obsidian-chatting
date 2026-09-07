import type { SessionStorageAdapter } from "../storage-adapter";
import {
  assertValidSessionMetadataId,
  decodeSessionMetadata,
  encodeSessionMetadata,
} from "./codec";
import {
  CONVERSATION_DELETION_MARKER_SCHEMA_VERSION,
  type ConversationDeletionMarker,
  type SessionMetadata,
} from "./types";

export const DEFAULT_SESSION_METADATA_ROOT = ".chatting/session-metadata";
export const METADATA_SUFFIX = ".meta.json";
export const DELETION_MARKER_SUFFIX = ".deleted.json";

export interface StoredSessionMetadata {
  metadata: SessionMetadata;
  unknownFields: Record<string, unknown>;
  needsMigration: boolean;
}

/**
 * Canonical metadata store. Files are directly Claudian-shaped metadata objects.
 * There is no Chatting wrapper document and no normal-path projection step.
 */
export class SessionMetadataStore {
  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly root = DEFAULT_SESSION_METADATA_ROOT,
  ) {}

  metadataPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.root}/${id}${METADATA_SUFFIX}`;
  }

  deletionMarkerPath(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.root}/${id}${DELETION_MARKER_SUFFIX}`;
  }

  async load(id: string): Promise<StoredSessionMetadata | null> {
    const path = this.metadataPath(id);
    if (!await this.adapter.exists(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.adapter.read(path));
    } catch {
      return null;
    }
    const decoded = decodeSessionMetadata(parsed, id);
    if (!decoded) return null;
    return decoded;
  }

  async save(
    metadata: SessionMetadata,
    unknownFields: Record<string, unknown> = {},
  ): Promise<void> {
    const path = this.metadataPath(metadata.id);
    await this.adapter.ensureFolder(this.root);
    const payload = encodeSessionMetadata(metadata, unknownFields);
    await writeJsonSafely(this.adapter, path, payload);
  }

  async list(): Promise<StoredSessionMetadata[]> {
    await this.adapter.ensureFolder(this.root);
    const paths = await this.adapter.listFiles(this.root);
    const out: StoredSessionMetadata[] = [];
    for (const path of paths) {
      const filename = path.split("/").at(-1) ?? path;
      if (!filename.endsWith(METADATA_SUFFIX)) continue;
      const id = filename.slice(0, -METADATA_SUFFIX.length);
      if (!id) continue;
      const loaded = await this.load(id);
      if (loaded) out.push(loaded);
    }
    return out.sort((a, b) => b.metadata.lastActivityAt - a.metadata.lastActivityAt);
  }

  async markDeleted(id: string, deletedAt = Date.now()): Promise<void> {
    const marker: ConversationDeletionMarker = {
      schemaVersion: CONVERSATION_DELETION_MARKER_SCHEMA_VERSION,
      conversationId: id,
      deletedAt,
    };
    await this.adapter.ensureFolder(this.root);
    await writeJsonSafely(this.adapter, this.deletionMarkerPath(id), marker);
  }

  async isDeleted(id: string): Promise<boolean> {
    return this.adapter.exists(this.deletionMarkerPath(id));
  }

  async clearDeletionMarker(id: string): Promise<void> {
    const path = this.deletionMarkerPath(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async removeMetadata(id: string): Promise<void> {
    const path = this.metadataPath(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

async function writeJsonSafely(
  adapter: SessionStorageAdapter,
  path: string,
  value: unknown,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  JSON.parse(serialized);
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  await adapter.write(tmp, serialized);
  if (await adapter.exists(path)) {
    if (await adapter.exists(bak)) await adapter.remove(bak);
    await adapter.rename(path, bak);
  }
  await adapter.rename(tmp, path);
}
