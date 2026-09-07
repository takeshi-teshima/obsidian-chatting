<script lang="ts">
  /**
   * Turn-level model/reasoning selector (Session Workspaces v4.3, branch 13:
   * turn-model-selection). Lives in the composer control row, not just the
   * passive header label — see CHAT_UI_INTEGRATION.md in the v4.3 kit.
   *
   * This control always edits the session's NEXT-turn selection
   * (SessionManager.setNextTurnSelection). It never mutates plugin-global
   * settings and never aborts/restarts the runtime. It stays enabled while a
   * turn is running: SessionManager admits an immutable snapshot at Send
   * time, so changing this control mid-turn only affects the next send.
   *
   * Branch 14 replaces this generic <select>-based control with a
   * Claudian-style ModelSelector.svelte/ReasoningSelector.svelte pair; this
   * component intentionally stays minimal so that swap is a clean removal.
   */
  interface ModelOption {
    value: string;
    label: string;
  }

  interface Props {
    models: ModelOption[];
    selectedModel: string;
    reasoningEfforts: string[];
    selectedReasoningEffort: string | undefined;
    /** True when the running/queued turn's admitted config differs from this pending selection. */
    pendingDiffersFromActive: boolean;
    onModelChange: (model: string) => void;
    onReasoningChange: (effort: string) => void;
  }

  let {
    models,
    selectedModel,
    reasoningEfforts,
    selectedReasoningEffort,
    pendingDiffersFromActive,
    onModelChange,
    onReasoningChange,
  }: Props = $props();

  function handleModelChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    onModelChange(value);
  }

  function handleReasoningChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    onReasoningChange(value);
  }
</script>

<div class="ochatting-turn-selector">
  <label class="ochatting-turn-selector-field">
    <span class="ochatting-turn-selector-label">Model</span>
    <select class="ochatting-turn-selector-select" value={selectedModel} onchange={handleModelChange}>
      {#each models as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
      {#if !models.some((m) => m.value === selectedModel)}
        <option value={selectedModel}>{selectedModel}</option>
      {/if}
    </select>
  </label>

  {#if reasoningEfforts.length > 0}
    <label class="ochatting-turn-selector-field">
      <span class="ochatting-turn-selector-label">Effort</span>
      <select
        class="ochatting-turn-selector-select"
        value={selectedReasoningEffort ?? "auto"}
        onchange={handleReasoningChange}
      >
        {#each reasoningEfforts as effort (effort)}
          <option value={effort}>{effort}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if pendingDiffersFromActive}
    <span class="ochatting-turn-selector-badge" title="This response is still using the model/effort selected when you sent it. Your change applies to the next message.">
      Next message
    </span>
  {/if}
</div>

<style>
  .ochatting-turn-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 2px 0 6px;
    min-width: 0;
  }

  .ochatting-turn-selector-field {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .ochatting-turn-selector-label {
    font-size: 0.75em;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .ochatting-turn-selector-select {
    max-width: 40vw;
    min-width: 0;
    font-size: 0.8em;
    padding: 1px 4px;
  }

  .ochatting-turn-selector-badge {
    font-size: 0.7em;
    color: var(--text-accent);
    border: 1px solid var(--text-accent);
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
  }

  /* Compact pane (<=439px, see src/ui/responsive/pane-layout.ts): drop the
     text labels but keep both selects usable/touch-sized. Reuses branch 12's
     existing pane-width attribute; this component never observes width
     itself. */
  :global([data-ochatting-pane-layout="compact"]) .ochatting-turn-selector-label {
    display: none;
  }

  :global([data-ochatting-pane-layout="compact"]) .ochatting-turn-selector-select {
    max-width: 32vw;
  }
</style>
