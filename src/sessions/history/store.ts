import type { UnifiedMessage } from "../../types";
import type { SessionStorageAdapter } from "../storage-adapter";
import { assertValidSessionMetadataId } from "../metadata/codec";

export const DEFAULT_SESSION_HISTORY_ROOT = ".chatting/sessions";

/**
 * Chatting is itself a provider from Claudian's point of view, so its transcript
 * is provider-native history. We persist the plugin's existing UnifiedMessage
 * objects directly, one JSON object per line, rather than inventing a second
 * canonical session wrapper schema.
 */
export class ChattingHistoryStore {
  constructor(
    private readonly adapter: SessionStorageAdapter,
    private readonly root = DEFAULT_SESSION_HISTORY_ROOT,
  ) {}

  pathFor(id: string): string {
    assertValidSessionMetadataId(id);
    return `${this.root}/${id}.jsonl`;
  }

  async load(id: string): Promise<UnifiedMessage[]> {
    const path = this.pathFor(id);
    if (!await this.adapter.exists(path)) return [];
    const text = await this.adapter.read(path);
    const messages: UnifiedMessage[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isUnifiedMessageShape(parsed)) messages.push(parsed as UnifiedMessage);
      } catch {
        // Skip malformed line. The caller may surface a diagnostic count later.
      }
    }
    return messages;
  }

  /**
   * Portable implementation that only needs adapter.write. Integration may use
   * a mobile-safe append API if available, but must keep the same JSONL bytes.
   */
  async append(id: string, messages: readonly UnifiedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.adapter.ensureFolder(this.root);
    const path = this.pathFor(id);
    const current = await this.adapter.exists(path) ? await this.adapter.read(path) : "";
    const suffix = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    await this.adapter.write(path, current + suffix);
  }

  async replace(id: string, messages: readonly UnifiedMessage[]): Promise<void> {
    await this.adapter.ensureFolder(this.root);
    const body = messages.map((message) => JSON.stringify(message)).join("\n");
    await this.adapter.write(this.pathFor(id), body.length > 0 ? `${body}\n` : "");
  }

  async remove(id: string): Promise<void> {
    const path = this.pathFor(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

export function isUnifiedMessageShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.role === "user" || record.role === "assistant")
    && (typeof record.content === "string" || Array.isArray(record.content))
  );
}
