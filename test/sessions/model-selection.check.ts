import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeApp } from "./fake-app";
import { ObsidianSessionStorageAdapter } from "../../src/sessions/obsidian-storage-adapter";
import { SessionMetadataStore } from "../../src/sessions/metadata/store";
import { ChattingHistoryStore } from "../../src/sessions/history/store";
import { SessionIndexStore } from "../../src/sessions/index/store";
import { SessionLocalStateStore } from "../../src/sessions/local/store";
import { SessionWorkspaceStore } from "../../src/sessions/store";
import { SessionManager } from "../../src/sessions/runtime/manager";
import type { SessionAgentAdapter, SessionAgentCallbacks } from "../../src/sessions/runtime/runtime";
import type { SessionRunRequest } from "../../src/sessions/runtime/types";
import type { UnifiedMessage } from "../../src/types";
import { migrateLegacyModelSelection } from "../../src/model-selection/settings-migration";
import { ModelSelectionSeedCoordinator } from "../../src/model-selection/seed-coordinator";
import { ComposerSelectionCoordinator, type SelectionDraft } from "../../src/model-selection/selection-coordinator";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok - ${name}`); })
    .catch((error) => {
      console.error(`  FAIL - ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
    });
}

class FakeAgent implements SessionAgentAdapter {
  private messages: UnifiedMessage[] = [];
  importMessages(messages: UnifiedMessage[]): void { this.messages = structuredClone(messages); }
  exportMessages(): UnifiedMessage[] { return structuredClone(this.messages); }
  resetProviderContinuation(): void { /* no-op */ }
  abort(): void { /* no-op */ }
  async run(request: SessionRunRequest, callbacks: SessionAgentCallbacks): Promise<void> {
    this.messages.push({ role: "user", content: request.text });
    callbacks.onThinking();
    this.messages.push({ role: "assistant", content: "ok" });
    callbacks.onResponse("ok");
  }
}

async function mkStore(): Promise<SessionWorkspaceStore> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "chatting-v4-model-selection-"));
  const app = createFakeApp(vault);
  const adapter = new ObsidianSessionStorageAdapter(app);
  const store = new SessionWorkspaceStore(
    new SessionMetadataStore(adapter),
    new ChattingHistoryStore(adapter),
    new SessionLocalStateStore(adapter),
    new SessionIndexStore(adapter),
  );
  await store.initialize();
  return store;
}

async function main(): Promise<void> {
  console.log("== branch 14: settings migration seed ==");
  await check("legacy provider+model seeds lastSelectedChatModel exactly once", () => {
    const first = migrateLegacyModelSelection({ provider: "openai", model: "gpt-test" });
    assert.equal(first.migrated, true);
    assert.deepEqual(first.seed, { providerId: "openai", model: "gpt-test" });
    // A second pass over settings that already carry the seed must not remigrate/overwrite it.
    const second = migrateLegacyModelSelection(first.settings);
    assert.equal(second.migrated, false);
    assert.deepEqual(second.seed, { providerId: "openai", model: "gpt-test" });
  });

  console.log("\n== branch 14: pristine-vs-bound provider switch (SessionManager.setNextTurnSelection) ==");
  const store = await mkStore();
  const manager = new SessionManager({
    store,
    agentFactory: { create: () => new FakeAgent() },
    getDefaultSessionSeed: () => ({ title: "New chat" }),
    getTurnSelectionFallback: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    maxConcurrentRuns: 3,
    maxHydratedRuntimes: 8,
  });

  const pristine = (await manager.createSession({
    title: "Pristine", selectedModel: "claude-sonnet-4-6", upstreamProvider: "anthropic",
  })).metadata.id;

  await check("messageCount === 0: cross-provider switch is accepted", async () => {
    const meta = await store.getMeta(pristine);
    assert.equal(meta?.messageCount, 0);
    await manager.setNextTurnSelection(pristine, { provider: "openai", model: "gpt-5.4" });
    const loaded = await store.load(pristine);
    assert.equal(loaded?.metadata.selectedModel, "gpt-5.4");
    const state = loaded?.metadata.providerState as { upstreamProvider?: string } | undefined;
    assert.equal(state?.upstreamProvider, "openai");
  });

  await check("same-provider model change on a pristine session still works", async () => {
    await manager.setNextTurnSelection(pristine, { provider: "openai", model: "gpt-4o" });
    const loaded = await store.load(pristine);
    assert.equal(loaded?.metadata.selectedModel, "gpt-4o");
  });

  // Send a real turn so the session is no longer pristine (messageCount > 0).
  await manager.run(pristine, { text: "hello" });

  await check("after first persisted message, messageCount > 0", async () => {
    const meta = await store.getMeta(pristine);
    assert.ok((meta?.messageCount ?? 0) > 0, `expected messageCount > 0, got ${meta?.messageCount}`);
  });

  await check("cross-provider switch is now rejected without corrupting session state", async () => {
    const before = await store.load(pristine);
    await assert.rejects(
      () => manager.setNextTurnSelection(pristine, { provider: "anthropic", model: "claude-sonnet-4-6" }),
      /uses openai/,
    );
    const after = await store.load(pristine);
    // Session state must be unchanged after the rejected attempt: same
    // provider, same model, same message count — nothing partially applied.
    assert.equal(after?.metadata.selectedModel, before?.metadata.selectedModel);
    const beforeState = before?.metadata.providerState as { upstreamProvider?: string } | undefined;
    const afterState = after?.metadata.providerState as { upstreamProvider?: string } | undefined;
    assert.equal(afterState?.upstreamProvider, beforeState?.upstreamProvider);
    assert.equal(after?.messages.length, before?.messages.length);
  });

  await check("same-provider model change remains allowed after the conversation has started", async () => {
    await manager.setNextTurnSelection(pristine, { provider: "openai", model: "gpt-5.3-codex" });
    const loaded = await store.load(pristine);
    assert.equal(loaded?.metadata.selectedModel, "gpt-5.3-codex");
  });

  console.log("\n== branch 14: latest-wins coordination ==");
  await check("ComposerSelectionCoordinator: a stale request completing late does not roll back a newer explicit choice", async () => {
    let draft: SelectionDraft = { providerId: "openai", model: "a", reasoningEffort: "medium" };
    let persisted = draft;
    let releaseStale: (() => void) | undefined;
    const coordinator = new ComposerSelectionCoordinator({
      isOwnerLive: () => true,
      readDraft: () => draft,
      applyDraft: (next) => { draft = next; },
      restoreDraft: (previous) => { draft = previous; },
      initializeProvider: async () => undefined,
      persistSelection: async (next) => {
        if (next.model === "stale") {
          // Simulate a slow async model-metadata fetch/persist that completes
          // AFTER a newer request has already been made current.
          await new Promise<void>((resolve) => { releaseStale = resolve; });
        }
        persisted = next;
      },
    });

    const staleRequest = coordinator.beginRequest();
    const stalePromise = coordinator.select(staleRequest, { ...draft, model: "stale" }, { allowProviderSwitch: false });

    // A newer request supersedes it before the stale one's persistSelection resolves.
    const freshRequest = coordinator.beginRequest();
    const freshResult = await coordinator.select(freshRequest, { ...draft, model: "fresh" }, { allowProviderSwitch: false });
    assert.equal(freshResult.status, "succeeded");
    assert.equal(persisted.model, "fresh");
    assert.equal(draft.model, "fresh");

    // Now let the stale request's persistSelection complete late.
    releaseStale?.();
    const staleResult = await stalePromise;
    assert.equal(staleResult.status, "superseded");
    // The late completion must not have rolled back the fresh choice.
    assert.equal(persisted.model, "fresh");
    assert.equal(draft.model, "fresh");
  });

  await check("ModelSelectionSeedCoordinator: a stale intent committing late does not roll back a newer explicit choice", async () => {
    const settings: Record<string, unknown> = {};
    const coordinator = new ModelSelectionSeedCoordinator({
      mutate: async (update) => { update(settings); },
    });

    const staleIntent = coordinator.beginIntent();
    const freshIntent = coordinator.beginIntent();

    // Commit the FRESH intent first (as if its persistence finished sooner).
    const freshCommitted = await coordinator.commitIntent(freshIntent, { providerId: "openai", model: "fresh" }, () => true);
    assert.equal(freshCommitted, true);
    assert.deepEqual(settings.lastSelectedChatModel, { providerId: "openai", model: "fresh" });

    // The STALE intent (lower intent number) now tries to commit late.
    const staleCommitted = await coordinator.commitIntent(staleIntent, { providerId: "anthropic", model: "stale" }, () => true);
    assert.equal(staleCommitted, false, "a stale (lower) intent must not be allowed to commit after a newer one already has");
    assert.deepEqual(settings.lastSelectedChatModel, { providerId: "openai", model: "fresh" }, "seed must still reflect the newer choice");
  });

  console.log(`\n${passed} checks passed.`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
