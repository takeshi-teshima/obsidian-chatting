<script lang="ts">
  /**
   * Claudian-style composer reasoning-effort picker (Session Workspaces
   * v4.3, branch 14). Colocated with ModelSelector.svelte; hidden entirely
   * when the currently-selected model has zero or one meaningful reasoning
   * choice (see UI_SPEC.md), which the host computes and passes as `options`.
   */
  import type { ComposerReasoningOption } from "../model-selection/types";

  interface Props {
    options: ComposerReasoningOption[];
    selected: string | undefined;
    onSelect: (effort: string) => void;
  }

  let { options, selected, onSelect }: Props = $props();

  let open = $state(false);
  let rootEl: HTMLElement | undefined = $state();

  const selectedOption = $derived(options.find((o) => o.value === selected) ?? options[0] ?? null);

  function toggle(): void { open = !open; }
  function close(): void { open = false; }
  function choose(option: ComposerReasoningOption): void {
    close();
    if (option.value === selected) return;
    onSelect(option.value);
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

{#if options.length > 1}
  <div class="ochatting-reasoning-selector" bind:this={rootEl}>
    <button
      type="button"
      class="ochatting-reasoning-selector-trigger"
      onclick={toggle}
      aria-haspopup="listbox"
      aria-expanded={open}
    >
      <span class="ochatting-reasoning-selector-label">Effort: {selectedOption?.label ?? "Auto"}</span>
      <span class="ochatting-reasoning-selector-caret">▾</span>
    </button>

    {#if open}
      <div class="ochatting-reasoning-selector-popover" role="listbox">
        {#each options as option (option.value)}
          <button
            type="button"
            class="ochatting-reasoning-selector-item"
            role="option"
            aria-selected={option.value === selected}
            title={option.description}
            onclick={() => choose(option)}
          >
            <span class="ochatting-reasoning-selector-item-label">{option.label}</span>
            {#if option.value === selected}
              <span class="ochatting-reasoning-selector-check">✓</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .ochatting-reasoning-selector {
    position: relative;
    display: inline-block;
    min-width: 0;
  }

  .ochatting-reasoning-selector-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.8em;
    padding: 2px 6px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .ochatting-reasoning-selector-caret {
    color: var(--text-muted);
    font-size: 0.7em;
  }

  .ochatting-reasoning-selector-popover {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 140px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    box-shadow: var(--shadow-l);
    z-index: 50;
    padding: 4px;
  }

  .ochatting-reasoning-selector-item {
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

  .ochatting-reasoning-selector-item:hover,
  .ochatting-reasoning-selector-item:focus-visible {
    background: var(--background-modifier-hover);
  }

  .ochatting-reasoning-selector-item-label {
    flex: 1;
  }

  .ochatting-reasoning-selector-check {
    color: var(--text-accent);
  }

  /* Compact pane (<=439px): shorten the label to just the value. */
  :global([data-ochatting-pane-layout="compact"]) .ochatting-reasoning-selector-trigger {
    padding: 2px 4px;
  }
</style>
