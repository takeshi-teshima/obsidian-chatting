<script lang="ts">
  /**
   * Claudian-style composer model picker (Session Workspaces v4.3, branch 14).
   * Replaces branch 13's generic <select>-based TurnModelSelector.svelte.
   *
   * Always edits the bound conversation's NEXT-turn selection — never
   * plugin-global settings — via the caller's onSelect callback, which the
   * host (ChatContainer -> chat-view.ts) routes through
   * ComposerSelectionCoordinator for latest-wins ordering. Stays enabled
   * while a turn is running: branch 13 admits an immutable snapshot at Send,
   * so a change here only affects the next send.
   */
  import type { ComposerModelOption } from "../model-selection/types";

  interface Props {
    options: ComposerModelOption[];
    selectedProviderId: string;
    selectedModel: string;
    /** True only for a pristine (messageCount === 0) conversation: groups options by provider. */
    allowProviderSwitch: boolean;
    onSelect: (providerId: string, model: string) => void;
  }

  let { options, selectedProviderId, selectedModel, allowProviderSwitch, onSelect }: Props = $props();

  let open = $state(false);
  let rootEl: HTMLElement | undefined = $state();

  const selectedOption = $derived(
    options.find((o) => o.providerId === selectedProviderId && o.value === selectedModel) ?? null,
  );

  const groups = $derived.by(() => {
    const map = new Map<string, ComposerModelOption[]>();
    for (const option of options) {
      const key = allowProviderSwitch ? (option.group ?? option.providerId) : "";
      const list = map.get(key) ?? [];
      list.push(option);
      map.set(key, list);
    }
    return [...map.entries()];
  });

  function toggle(): void {
    open = !open;
  }

  function close(): void {
    open = false;
  }

  function choose(option: ComposerModelOption): void {
    close();
    if (option.providerId === selectedProviderId && option.value === selectedModel) return;
    onSelect(option.providerId, option.value);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!open || !rootEl) return;
    if (!rootEl.contains(event.target as Node)) close();
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<div class="ochatting-model-selector" bind:this={rootEl}>
  <button
    type="button"
    class="ochatting-model-selector-trigger"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if selectedOption?.providerIcon}
      <span class="ochatting-model-selector-icon">{selectedOption.providerIcon}</span>
    {/if}
    <span class="ochatting-model-selector-label">{selectedOption?.label ?? selectedModel}</span>
    <span class="ochatting-model-selector-caret">▾</span>
  </button>

  {#if open}
    <div class="ochatting-model-selector-popover" role="listbox">
      {#each groups as [group, groupOptions] (group)}
        {#if group}
          <div class="ochatting-model-selector-group-label">{group}</div>
        {/if}
        {#each groupOptions as option (option.providerId + ":" + option.value)}
          <button
            type="button"
            class="ochatting-model-selector-item"
            role="option"
            aria-selected={option.providerId === selectedProviderId && option.value === selectedModel}
            title={option.description}
            onclick={() => choose(option)}
          >
            {#if option.providerIcon}
              <span class="ochatting-model-selector-icon">{option.providerIcon}</span>
            {/if}
            <span class="ochatting-model-selector-item-label">{option.label}</span>
            {#if option.providerId === selectedProviderId && option.value === selectedModel}
              <span class="ochatting-model-selector-check">✓</span>
            {/if}
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .ochatting-model-selector {
    position: relative;
    display: inline-block;
    min-width: 0;
  }

  .ochatting-model-selector-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.8em;
    padding: 2px 6px;
    max-width: 40vw;
    min-width: 0;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .ochatting-model-selector-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-model-selector-caret {
    color: var(--text-muted);
    font-size: 0.7em;
  }

  .ochatting-model-selector-popover {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 200px;
    max-width: 70vw;
    max-height: 50vh;
    overflow-y: auto;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    box-shadow: var(--shadow-l);
    z-index: 50;
    padding: 4px;
  }

  .ochatting-model-selector-group-label {
    font-size: 0.7em;
    color: var(--text-muted);
    padding: 4px 6px 2px;
    text-transform: uppercase;
  }

  .ochatting-model-selector-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    background: none;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }

  .ochatting-model-selector-item:hover,
  .ochatting-model-selector-item:focus-visible {
    background: var(--background-modifier-hover);
  }

  .ochatting-model-selector-item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-model-selector-check {
    color: var(--text-accent);
  }

  /* Compact pane (<=439px): keep the trigger touch-sized and avoid horizontal overflow. */
  :global([data-ochatting-pane-layout="compact"]) .ochatting-model-selector-trigger {
    max-width: 50vw;
  }

  :global([data-ochatting-pane-layout="compact"]) .ochatting-model-selector-popover {
    max-width: 90vw;
    left: 0;
    right: 0;
  }
</style>
