import type { StoredChatModelSelection } from "./types";

export interface SeedPersistence {
  mutate(
    update: (settings: Record<string, unknown>) => boolean | void,
  ): Promise<void>;
}

/**
 * Application-wide ordering for explicit picker choices.
 * Mirrors Claudian's rule: the latest successful explicit picker intent seeds
 * future blank conversations, while existing conversations never subscribe
 * to the seed. A slow async model-metadata fetch completing late must not
 * roll back a newer explicit choice — `commitIntent` enforces that by
 * refusing to apply an intent number lower than the last committed one.
 */
export class ModelSelectionSeedCoordinator {
  private nextIntent = 0;
  private committedIntent = 0;
  private commitTail: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: SeedPersistence) {}

  beginIntent(): number {
    this.nextIntent += 1;
    return this.nextIntent;
  }

  commitIntent(
    intent: number,
    selection: StoredChatModelSelection,
    isStillValid: () => boolean,
  ): Promise<boolean> {
    let committed = false;
    const commit = this.commitTail.then(async () => {
      if (intent <= this.committedIntent || !isStillValid()) return;
      await this.persistence.mutate((settings) => {
        if (!isStillValid()) return false;
        settings.lastSelectedChatModel = { ...selection };
        committed = true;
        return true;
      });
      if (committed) this.committedIntent = intent;
    });
    this.commitTail = commit.then(() => undefined, () => undefined);
    return commit.then(() => committed);
  }
}
