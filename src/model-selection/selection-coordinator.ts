import type { ComposerSelection } from "./types";

export type SelectionDraft = ComposerSelection;

export interface SelectionRequest {
  readonly revision: number;
}

export type SelectionResult =
  | { status: "succeeded"; isCurrent(): boolean }
  | { status: "superseded" };

export interface SelectionEffects {
  isOwnerLive(): boolean;
  readDraft(): SelectionDraft;
  applyDraft(next: SelectionDraft): void;
  restoreDraft(previous: SelectionDraft): void;
  /** Called only when a pristine conversation moves to another upstream provider. */
  initializeProvider(providerId: SelectionDraft["providerId"]): Promise<void>;
  /** Persist conversation metadata after local UI state is staged. */
  persistSelection(next: SelectionDraft): Promise<void>;
}

/**
 * Claudian-inspired per-composer selection ordering: the latest picker intent
 * wins over any overlapping earlier one. Cross-provider transitions are
 * serialized through `transitionTail`, and a failed persistence/provider
 * initialization restores the last stable draft rather than leaving the UI
 * showing an unpersisted choice.
 */
export class ComposerSelectionCoordinator {
  private latestRevision = 0;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(private readonly effects: SelectionEffects) {}

  beginRequest(): SelectionRequest {
    this.latestRevision += 1;
    return { revision: this.latestRevision };
  }

  isCurrent(request: SelectionRequest): boolean {
    return this.effects.isOwnerLive() && request.revision === this.latestRevision;
  }

  async select(
    request: SelectionRequest,
    target: SelectionDraft,
    options: { allowProviderSwitch: boolean },
  ): Promise<SelectionResult> {
    if (!this.isCurrent(request)) return { status: "superseded" };

    const previous = this.effects.readDraft();
    if (!options.allowProviderSwitch && target.providerId !== previous.providerId) {
      throw new Error("Cannot switch provider after this conversation has started. Start or fork a conversation instead.");
    }

    this.effects.applyDraft(target);
    const run = async (): Promise<void> => {
      if (target.providerId !== previous.providerId) {
        await this.effects.initializeProvider(target.providerId);
      }
      if (!this.isCurrent(request)) return;
      await this.effects.persistSelection(target);
    };

    const transition = this.transitionTail.then(run);
    this.transitionTail = transition.then(() => undefined, () => undefined);
    try {
      await transition;
    } catch (error) {
      if (this.isCurrent(request)) this.effects.restoreDraft(previous);
      throw error;
    }
    if (!this.isCurrent(request)) return { status: "superseded" };
    return { status: "succeeded", isCurrent: () => this.isCurrent(request) };
  }
}
