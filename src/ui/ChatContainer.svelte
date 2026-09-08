<script lang="ts">
  import type { App, Component as ObsidianComponent } from "obsidian";
  import { MarkdownRenderer } from "obsidian";
  import type { ToolResult, SelectionScope } from "../types";
  import type { ContextRef } from "../context/refs";
  import { parsePdfMention, buildPdfScopedContext, choosePdf } from "../context/pdf-mention";
  import { parseImageMention, buildImageScopedContext, chooseImage } from "../context/image-mention";
  import { mergeContextRefs, contextRefLabel } from "../context/ref-list";
  import ModelSelector from "./ModelSelector.svelte";
  import ReasoningSelector from "./ReasoningSelector.svelte";
  import type { ComposerModelOption, ComposerReasoningOption } from "../model-selection/types";

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking";
    text?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
  }

  interface Props {
    app: App;
    component: ObsidianComponent;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null, contextRefs: ContextRef[]) => void;
    onStop: () => void;
    /** Copies device/pasted image files into the vault and reports back ContextRefs + per-file errors. */
    onAttachFiles: (files: File[]) => Promise<void>;
    /**
     * Claudian-style composer model/reasoning selection (branch 14): always
     * edits the bound conversation's NEXT-turn selection. `onModelChange`
     * carries providerId because a pristine (messageCount===0) conversation
     * may switch provider through the model picker.
     */
    onModelChange: (providerId: string, model: string) => void;
    onReasoningChange: (effort: string) => void;
    /**
     * `plugin.settings.sendOnEnter` (Settings → "Send on Enter"), mirroring
     * how `provider`/`model` above are threaded in from plugin settings.
     * `true`: plain Enter sends, Shift+Enter inserts a newline (the
     * plugin's original hardcoded behavior). `false` (default): plain
     * Enter inserts a newline and Cmd/Ctrl+Enter sends instead. See
     * `handleKeydown` below.
     */
    sendOnEnter: boolean;
  }

  let {
    app,
    component,
    provider,
    model,
    onSend,
    onStop,
    onAttachFiles,
    onModelChange,
    onReasoningChange,
    sendOnEnter,
  }: Props = $props();

  // Turn-level selector state, updated exclusively via setNextTurnSelection()
  // below (called from chat-view.ts on every session snapshot/switch). This
  // is deliberately NOT derived from the `model` prop: `model`/`displayModel`
  // reflect the header label, while these reflect the composer's editable
  // next-send selection, including models/efforts not yet known when this
  // component first mounted.
  let turnModelOptions = $state<ComposerModelOption[]>([]);
  let turnSelectedProviderId = $state("");
  let turnSelectedModel = $state("");
  let turnAllowProviderSwitch = $state(false);
  let turnReasoningOptions = $state<ComposerReasoningOption[]>([]);
  let turnSelectedReasoningEffort = $state<string | undefined>(undefined);
  let turnPendingDiffersFromActive = $state(false);

  const SUPPORTED_PASTE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  let fileInputEl: HTMLInputElement | undefined = $state();

  let displayModel = $state("");
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let nextId = 0;

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // Generic, provider-neutral vault-asset references already attached to
  // the composer (e.g. via a future paste/attachment flow). This is the
  // single source of truth for "already attached" context — `@pdf`/`@image`
  // mentions below are resolved into this same representation at send
  // time rather than living in their own parallel state slots.
  let contextRefs = $state<ContextRef[]>([]);

  // Live preview of an `@pdf ...` / `@image ...` mention in the composer
  // text. Recomputed from `inputText` on every change (cheap: metadata-only
  // vault lookups, no file reads). Drives the removable mention pill and is
  // re-derived at send time so it's always in sync with what's about to be
  // sent.
  let pdfMention = $derived(parsePdfMention(app, inputText));
  let imageMention = $derived(parseImageMention(app, inputText));

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  // Sync model prop to local state (also updateable via setModel)
  $effect(() => {
    displayModel = model;
  });

  // Auto-scroll when messages change
  $effect(() => {
    // Track messages array length to trigger scroll
    messages.length;
    if (messagesEl) {
      requestAnimationFrame(() => {
        messagesEl!.scrollTop = messagesEl!.scrollHeight;
      });
    }
  });

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(text: string): void {
    messages.push({ id: nextId++, type: "user", text });
  }

  export function addAssistantMessage(text: string): void {
    messages.push({ id: nextId++, type: "assistant", text });
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  export function showThinking(): void {
    // Only add if not already showing
    if (!messages.some((m) => m.type === "thinking")) {
      messages.push({ id: nextId++, type: "thinking" });
    }
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string): void {
    messages.push({ id: nextId++, type: "error", text });
  }

  export function showAskUser(question: string): Promise<string> {
    addAssistantMessage(question);
    placeholder = "Type your answer...";
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    placeholder = enabled ? "Ask anything..." : "Waiting for response...";
  }

  export function clearMessages(): void {
    messages = [];
    selection = null;
    contextRefs = [];
    hideThinking();
  }

  /** Attach a context ref to the composer (e.g. from a future paste/attachment flow). */
  export function addContextRef(ref: ContextRef): void {
    contextRefs = mergeContextRefs(contextRefs, [ref]);
  }

  /** Remove a single attached context ref (never touches the underlying vault file). */
  export function removeContextRefById(id: string): void {
    contextRefs = contextRefs.filter((r) => r.id !== id);
  }

  /** Current snapshot of attached context refs. */
  export function getContextRefs(): ContextRef[] {
    return [...contextRefs];
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Update the model display name in the header */
  export function setModel(name: string): void {
    displayModel = name;
  }

  /**
   * Update the composer's turn-level model/reasoning selector. Called from
   * chat-view.ts whenever the bound session's runtime snapshot changes
   * (session switch, external setNextTurnSelection call, migration fallback
   * resolution) so the control always reflects `SessionMetadata.selectedModel`
   * / `providerState.reasoningEffort` — never plugin-global settings.
   */
  export function setNextTurnSelection(
    modelOptions: ComposerModelOption[],
    selectedProviderId: string,
    selectedModel: string,
    allowProviderSwitch: boolean,
    reasoningOptions: ComposerReasoningOption[],
    selectedReasoningEffort: string | undefined,
    pendingDiffersFromActive: boolean,
  ): void {
    turnModelOptions = modelOptions;
    turnSelectedProviderId = selectedProviderId;
    turnSelectedModel = selectedModel;
    turnAllowProviderSwitch = allowProviderSwitch;
    turnReasoningOptions = reasoningOptions;
    turnSelectedReasoningEffort = selectedReasoningEffort;
    turnPendingDiffersFromActive = pendingDiffersFromActive;
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  async function handleSend(): Promise<void> {
    const raw = inputText.trim();
    if (!raw && contextRefs.length === 0) return;

    if (askUserResolve) {
      if (!raw) return; // answering a question always needs text
      inputText = "";
      resetHeight();
      addUserMessage(raw);
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(raw);
      return;
    }

    // Single owner of `@pdf ...` / `@image ...` mention parsing: resolve (or
    // error, or open a picker for a bare mention) before this turn is ever
    // handed to the agent loop. Cancelling a picker must leave the composer
    // usable and must not send an unintended turn.
    const pdfParsed = parsePdfMention(app, raw);
    if (pdfParsed.error) {
      addError(pdfParsed.error);
      return;
    }

    let pdfRef = pdfParsed.ref;
    if (pdfParsed.needsPicker) {
      const chosen = await choosePdf(app);
      if (!chosen) return; // cancelled: leave composer usable, do not send
      pdfRef = chosen;
    }

    const imageParsed = parseImageMention(app, pdfParsed.text);
    if (imageParsed.error) {
      addError(imageParsed.error);
      return;
    }

    let imageRef = imageParsed.ref;
    if (imageParsed.needsPicker) {
      const chosen = await chooseImage(app);
      if (!chosen) return; // cancelled: leave composer usable, do not send
      imageRef = chosen;
    }

    // Consolidate PDF/image mentions into the single generic ContextRef[]
    // representation shared with any refs already attached to the composer
    // (e.g. from a future paste/attachment flow). No parallel pdfRef/imageRef
    // state is kept past this point.
    const newRefs = [pdfRef, imageRef].filter((r): r is ContextRef => !!r);
    let refs: ContextRef[];
    try {
      refs = mergeContextRefs(contextRefs, newRefs);
    } catch (e) {
      addError(e instanceof Error ? e.message : String(e));
      return;
    }

    const remainingText = imageParsed.text;
    // The provider accepts image-only user content, so allow sending with
    // no natural-language text as long as at least one ref is attached.
    if (!remainingText && refs.length === 0) return;

    inputText = "";
    resetHeight();
    contextRefs = []; // one-shot consumption, matching the existing @pdf convention

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;

    const scopedParts: string[] = [];
    if (pdfRef) scopedParts.push(buildPdfScopedContext(pdfRef));
    if (imageRef) scopedParts.push(buildImageScopedContext(imageRef));
    const text = scopedParts.length > 0
      ? `${scopedParts.join("\n\n")}\n\n${remainingText}`
      : remainingText;

    onSend(text, currentSelection, refs);
  }

  /**
   * Enter/send keybinding, gated by the `sendOnEnter` setting (default
   * `false` = newline-on-Enter):
   * - `sendOnEnter === true`: plain Enter sends, Shift+Enter inserts a
   *   newline. This is the plugin's original hardcoded behavior.
   * - `sendOnEnter === false` (default): plain Enter is left untouched
   *   (no `preventDefault()`) so the textarea inserts a newline exactly
   *   like a normal text box; Cmd+Enter (macOS) / Ctrl+Enter
   *   (Windows/Linux) sends instead. `metaKey || ctrlKey` is checked
   *   rather than branching on OS, matching the common cross-platform
   *   "mod+Enter" convention (e.g. Slack, GitHub) — no OS-detection
   *   convention exists elsewhere in this codebase to reuse (the
   *   responsive-layout code deliberately avoids Platform checks; see
   *   src/ui/responsive/pane-layout.ts), and either modifier is safe to
   *   accept on any platform since browsers/Electron don't assign Enter a
   *   conflicting native meaning with these modifiers held.
   */
  function handleKeydown(e: KeyboardEvent): void {
    if (sendOnEnter) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleAttachClick(): void {
    fileInputEl?.click();
  }

  async function handleFileInputChange(): Promise<void> {
    const files = Array.from(fileInputEl?.files ?? []);
    // Reset so re-selecting the same file again still fires `change`.
    if (fileInputEl) fileInputEl.value = "";
    if (files.length > 0) await onAttachFiles(files);
  }

  /**
   * Only intercepts clipboard paste when it actually carries supported image
   * files. The Svelte-level filter here is just a routing decision — the
   * controller's ImageIngestService performs the authoritative MIME check
   * (including rejecting HEIC/HEIF) before copying anything into the vault.
   */
  async function handlePaste(event: ClipboardEvent): Promise<void> {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      SUPPORTED_PASTE_MIME.includes(file.type)
    );
    if (files.length === 0) return; // ordinary text paste continues untouched
    event.preventDefault();
    await onAttachFiles(files);
  }

  /** Remove the `@pdf` mention token from the composer without sending. */
  function dismissPdfMention(): void {
    inputText = pdfMention.text;
  }

  /** Remove the `@image` mention token from the composer without sending. */
  function dismissImageMention(): void {
    inputText = imageMention.text;
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 300) + "px";
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
  }

  // Render markdown into a DOM node using Obsidian's renderer
  function renderMarkdown(node: HTMLElement, text: string): void {
    node.empty();
    MarkdownRenderer.render(app, text, node, "", component);
  }

  // Use action for markdown rendering
  function markdown(node: HTMLElement, text: string) {
    renderMarkdown(node, text);
    return {
      update(newText: string) {
        renderMarkdown(node, newText);
      },
    };
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }
</script>

<div class="ochatting-container">
  <!-- Header -->
  <div class="ochatting-header">
    <div class="ochatting-header-left">
      <span class="ochatting-header-title">Chat</span>
      <span class="ochatting-header-model">{displayModel || "No model"}</span>
    </div>
  </div>

  <!-- Messages -->
  <div class="ochatting-messages" bind:this={messagesEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="ochatting-msg ochatting-user-msg">
          <div class="ochatting-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "assistant"}
        <div class="ochatting-msg ochatting-assistant-msg">
          <div class="ochatting-msg-content" use:markdown={msg.text ?? ""}></div>
        </div>

      {:else if msg.type === "tool-call"}
        <div class="ochatting-tool-call">
          <div class="ochatting-tool-status">
            <span class="ochatting-spinner"></span>
            <span class="ochatting-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochatting-tool-details">
            <summary>Parameters</summary>
            <pre class="ochatting-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="ochatting-tool-call">
          <div class="ochatting-tool-status">
            <span class={msg.toolResult?.isError ? "ochatting-tool-error" : "ochatting-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="ochatting-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochatting-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            <pre class="ochatting-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
          </details>
        </div>

      {:else if msg.type === "error"}
        <div class="ochatting-msg ochatting-error-msg">
          <div class="ochatting-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="ochatting-thinking">
          <span class="ochatting-dot"></span>
          <span class="ochatting-dot"></span>
          <span class="ochatting-dot"></span>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Selection pill -->
  {#if selection}
    <div class="ochatting-selection-pill">
      <div class="ochatting-selection-content">
        <span class="ochatting-selection-label">Selection from {selection.filePath.split("/").pop()}</span>
        <span class="ochatting-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="ochatting-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  <!-- PDF mention pill: shown as soon as an `@pdf` token is typed. Stores
       only the resolved ContextRef's name/path for display — never bytes. -->
  {#if pdfMention.ref || pdfMention.needsPicker}
    <div class="ochatting-selection-pill">
      <div class="ochatting-selection-content">
        <span class="ochatting-selection-label">
          {pdfMention.ref ? `PDF: ${pdfMention.ref.name}` : "PDF: choose on send"}
        </span>
        {#if pdfMention.ref}
          <span class="ochatting-selection-preview">{pdfMention.ref.path}</span>
        {/if}
      </div>
      <button
        class="ochatting-selection-dismiss"
        onclick={dismissPdfMention}
        aria-label="Remove PDF mention"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  <!-- Image mention pill: shown as soon as an `@image` token is typed. Stores
       only the resolved ContextRef's name/path for display — never bytes. -->
  {#if imageMention.ref || imageMention.needsPicker}
    <div class="ochatting-selection-pill">
      <div class="ochatting-selection-content">
        <span class="ochatting-selection-label">
          {imageMention.ref ? `Image: ${imageMention.ref.name}` : "Image: choose on send"}
        </span>
        {#if imageMention.ref}
          <span class="ochatting-selection-preview">{imageMention.ref.path}</span>
        {/if}
      </div>
      <button
        class="ochatting-selection-dismiss"
        onclick={dismissImageMention}
        aria-label="Remove image mention"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  <!-- Generic attached context refs (e.g. from a future paste/attachment
       flow). Single removable pill per ref; no byte previews. -->
  {#each contextRefs as ref (ref.id)}
    <div class="ochatting-selection-pill">
      <div class="ochatting-selection-content">
        <span class="ochatting-selection-label">{contextRefLabel(ref)}</span>
        <span class="ochatting-selection-preview">{ref.path}</span>
      </div>
      <button
        class="ochatting-selection-dismiss"
        onclick={() => removeContextRefById(ref.id)}
        aria-label={`Remove ${ref.name}`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/each}

  <!-- Claudian-style model/reasoning selector (branch 14): edits the NEXT
       send, not the currently running turn. Reuses branch 12's pane-layout
       responsive attribute; see ModelSelector.svelte/ReasoningSelector.svelte. -->
  <div class="ochatting-turn-selector">
    <ModelSelector
      options={turnModelOptions}
      selectedProviderId={turnSelectedProviderId}
      selectedModel={turnSelectedModel}
      allowProviderSwitch={turnAllowProviderSwitch}
      onSelect={onModelChange}
    />
    <ReasoningSelector
      options={turnReasoningOptions}
      selected={turnSelectedReasoningEffort}
      onSelect={onReasoningChange}
    />
    {#if turnPendingDiffersFromActive}
      <span class="ochatting-turn-selector-badge" title="This response is still using the model/effort selected when you sent it. Your change applies to the next message.">
        Next message
      </span>
    {/if}
  </div>

  <!-- Input bar -->
  <div class="ochatting-input-bar">
    <input
      bind:this={fileInputEl}
      class="ochatting-hidden-file-input"
      type="file"
      accept="image/jpeg,image/png,image/webp,image/gif"
      multiple
      hidden
      onchange={() => void handleFileInputChange()}
    />
    <button
      class="ochatting-attach-btn"
      type="button"
      aria-label="Attach image"
      disabled={!inputEnabled}
      onclick={handleAttachClick}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
    </button>
    <textarea
      class="ochatting-input"
      bind:this={textareaEl}
      bind:value={inputText}
      {placeholder}
      disabled={!inputEnabled}
      rows="1"
      onkeydown={handleKeydown}
      oninput={autoGrow}
      onpaste={(event) => void handlePaste(event)}
    ></textarea>
    {#if inputEnabled}
      <button
        class="ochatting-send-btn"
        onclick={() => void handleSend()}
        aria-label="Send message"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
      </button>
    {:else}
      <button
        class="ochatting-send-btn ochatting-stop-btn"
        onclick={onStop}
        aria-label="Stop generation"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
      </button>
    {/if}
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .ochatting-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .ochatting-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .ochatting-header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
    /* Long model names/titles must never force the pane wider - shrink and
       truncate rather than overflow. See responsive-chat-shell notes below. */
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }

  .ochatting-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
    flex-shrink: 0;
  }

  .ochatting-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .ochatting-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochatting-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochatting-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  .ochatting-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .ochatting-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochatting-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .ochatting-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .ochatting-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .ochatting-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ochatting-tool-name {
    font-weight: 500;
  }

  .ochatting-tool-success {
    color: var(--text-success);
  }

  .ochatting-tool-error {
    color: var(--text-error);
  }

  .ochatting-tool-details {
    margin-top: 4px;
  }

  .ochatting-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .ochatting-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .ochatting-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: ochatting-spin 0.6s linear infinite;
  }

  @keyframes ochatting-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .ochatting-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .ochatting-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: ochatting-pulse 1.4s ease-in-out infinite;
  }

  .ochatting-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ochatting-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes ochatting-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Turn model/reasoning selector row (branch 14) ─────────────────── */
  .ochatting-turn-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 2px 0 6px;
    min-width: 0;
  }

  .ochatting-turn-selector-badge {
    font-size: 0.7em;
    color: var(--text-accent);
    border: 1px solid var(--text-accent);
    border-radius: 999px;
    padding: 1px 6px;
    white-space: nowrap;
  }

  :global([data-ochatting-pane-layout="compact"]) .ochatting-turn-selector-badge {
    display: none;
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .ochatting-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--background-modifier-border);
    background: transparent;
    flex-shrink: 0;
  }

  .ochatting-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: 20px;
    padding: 8px 16px;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    max-height: 300px;
    overflow-y: auto;
    box-shadow: none;
  }

  .ochatting-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .ochatting-input:disabled {
    opacity: 0.5;
  }

  .ochatting-send-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .ochatting-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .ochatting-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ochatting-stop-btn {
    background-color: var(--text-error);
  }

  .ochatting-stop-btn:hover {
    background-color: var(--text-error);
    opacity: 0.85;
  }

  .ochatting-hidden-file-input {
    display: none;
  }

  .ochatting-attach-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .ochatting-attach-btn:hover {
    color: var(--text-normal);
  }

  .ochatting-attach-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .ochatting-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .ochatting-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ochatting-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .ochatting-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochatting-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ochatting-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .ochatting-msg {
      max-width: 95%;
    }

    .ochatting-input-bar {
      gap: 10px;
      padding: 10px 12px;
      padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    }

    .ochatting-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
      padding: 10px 16px;
      border-radius: 22px;
    }

    .ochatting-send-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
    }
  }

  /*
   * Responsive chat shell (Session Workspaces v4.1, branch 12): keyed off
   * the actual ChatView pane width via ResizeObserver
   * (src/ui/responsive/pane-layout.ts sets data-ochatting-pane-layout on
   * this.contentEl in chat-view.ts's onOpen/onClose), never
   * window.innerWidth/Platform.isMobile/@media viewport queries - a narrow
   * desktop sidebar must render identically to a narrow mobile pane.
   *
   * The block above (@media max-width:768px) is left as-is: it exists
   * mainly for the iOS zoom-on-focus font-size fix, which is a genuine
   * physical-viewport/OS behavior, not a pane-width layout concern, so it
   * isn't a candidate for migration here. The rules below are additive and
   * only address the "content must never force the pane wider" acceptance
   * requirement (long model names, attachment/file names, tool JSON, code)
   * that @media can't express because it doesn't see the pane's real width
   * inside a resizable split/sidebar.
   *
   * `data-ochatting-pane-layout` lives on an ancestor this component does
   * not own (ObsidianChatView's contentEl, several DOM levels up from
   * .ochatting-container), so the ancestor part of each selector must be
   * :global() - only the .ochatting-* class stays Svelte-scoped.
   */
  :global([data-ochatting-pane-layout="compact"]) .ochatting-header {
    padding: 6px 8px;
    gap: 0.3em;
  }

  :global([data-ochatting-pane-layout="compact"]) .ochatting-header-title {
    display: none; /* "Chat" label is redundant at <=439px; keep only the model name and controls. */
  }

  :global([data-ochatting-pane-layout="wide"]) .ochatting-msg {
    max-width: 75%; /* On wide panes, full-width bubbles read poorly; narrower measure keeps text scannable. */
  }
</style>
