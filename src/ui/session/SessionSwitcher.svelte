<script lang="ts">
  import type { SessionRunPhase } from "../../session/types";

  export let title: string;
  export let phase: SessionRunPhase = "idle";
  export let hasUnreadActivity = false;
  export let onOpenBrowser: () => void;
  export let onNewSession: () => void;
  export let onMore: (event: MouseEvent) => void;

  $: status = phase === "queued" ? "Queued"
    : phase === "running" ? "Running"
    : phase === "waiting_user" ? "Needs input"
    : phase === "stopping" ? "Stopping"
    : "";
</script>

<div class="cw-session-switcher" aria-label="Conversation controls">
  <button class="icon" type="button" aria-label="Browse conversations" title="Browse conversations" on:click={onOpenBrowser}>☰</button>
  <button class="title" type="button" title="Switch conversation" on:click={onOpenBrowser}>
    <span class="text">{title || "New chat"}</span>
    <span class="chevron" aria-hidden="true">⌄</span>
  </button>
  {#if status}
    <span class:waiting={phase === "waiting_user"} class="status">{status}</span>
  {:else if hasUnreadActivity}
    <span class="unread" title="Unread activity" aria-label="Unread activity"></span>
  {/if}
  <button class="icon" type="button" aria-label="New conversation" title="New conversation" on:click={onNewSession}>＋</button>
  <button class="icon" type="button" aria-label="Conversation actions" title="Conversation actions" on:click={(e) => onMore(e)}>⋯</button>
</div>

<style>
  .cw-session-switcher { display:flex; align-items:center; gap:6px; min-width:0; }
  button { font:inherit; color:var(--text-normal); }
  .icon { border:0; background:transparent; width:30px; height:30px; border-radius:6px; cursor:pointer; }
  .icon:hover { background:var(--background-modifier-hover); }
  .title { min-width:0; max-width:420px; display:flex; align-items:center; gap:5px; border:0; background:transparent; padding:4px 7px; border-radius:6px; cursor:pointer; }
  .title:hover { background:var(--background-modifier-hover); }
  .text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .chevron { color:var(--text-muted); }
  .status { flex:none; font-size:11px; padding:2px 6px; border-radius:999px; background:var(--background-modifier-hover); color:var(--text-muted); }
  .status.waiting { color:var(--text-warning); }
  .unread { width:7px; height:7px; border-radius:50%; background:var(--interactive-accent); flex:none; }
</style>
