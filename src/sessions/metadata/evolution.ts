import type { SessionMetadata } from "./types";

/**
 * Dormant evolution boundary. The current storage path does NOT project:
 * canonical on-disk data is already Claudian-shaped SessionMetadata.
 *
 * If Claudian later introduces an incompatible metadata dialect, add an adapter
 * here rather than replacing the canonical Chatting model pre-emptively.
 */
export interface SessionMetadataDialectAdapter {
  readonly id: string;
  canRead(value: unknown): boolean;
  read(value: unknown): SessionMetadata | null;
  write(metadata: SessionMetadata): unknown;
}

export class IdentitySessionMetadataDialect implements SessionMetadataDialectAdapter {
  readonly id = "claudian-current-identity";

  constructor(
    private readonly decode: (value: unknown) => SessionMetadata | null,
  ) {}

  canRead(value: unknown): boolean {
    return this.decode(value) !== null;
  }

  read(value: unknown): SessionMetadata | null {
    return this.decode(value);
  }

  write(metadata: SessionMetadata): SessionMetadata {
    return metadata;
  }
}
