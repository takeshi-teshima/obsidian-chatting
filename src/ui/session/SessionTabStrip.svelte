<script context="module" lang="ts">
  import type { SessionRunPhase } from "../../session/types";

  export interface SessionTabItem {
    id: string;
    title: string;
    phase: SessionRunPhase;
    unread: boolean;
  }
</script>

<script lang="ts">
  export let tabs: SessionTabItem[] = [];
  export let currentSessionId: string | null = null;
  export let onSelect: (id: string) => void;
  export let onClose: (id: string) => void;
  export let onNew: () => void;

  function badge(tab: SessionTabItem): string {
    if (tab.phase === "running") return "●";
    if (tab.phase === "queued") return "◌";
    if (tab.phase === "waiting_user") return "!";
    if (tab.phase === "stopping") return "…";
    return tab.unread ? "•" : "";
  }
</script>

<nav class="cw-session-tabs" aria-label="Open conversation tabs">
  <div class="scroll">
    {#each tabs as tab (tab.id)}
      <div class:current={tab.id === currentSessionId} class="tab">
        <button class="select" type="button" title={tab.title} on:click={() => onSelect(tab.id)}>
          {#if badge(tab)}<span class:waiting={tab.phase === "waiting_user"} class="badge">{badge(tab)}</span>{/if}
          <span class="title">{tab.title || "New chat"}</span>
        </button>
        <button class="close" type="button" aria-label={`Close ${tab.title} tab`} title="Close tab (conversation keeps running)" on:click={() => onClose(tab.id)}>×</button>
      </div>
    {/each}
  </div>
  <button class="new" type="button" aria-label="New conversation" title="New conversation" on:click={onNew}>＋</button>
</nav>

<style>
  .cw-session-tabs { display:flex; min-width:0; align-items:center; border-bottom:1px solid var(--background-modifier-border); background:var(--background-secondary); }
  .scroll { display:flex; min-width:0; flex:1; overflow-x:auto; scrollbar-width:none; }
  .scroll::-webkit-scrollbar { display:none; }
  .tab { display:flex; flex:none; max-width:190px; align-items:center; border-right:1px solid var(--background-modifier-border); color:var(--text-muted); }
  .tab.current { background:var(--background-primary); color:var(--text-normal); }
  .select { display:flex; gap:5px; min-width:0; align-items:center; border:0; background:transparent; color:inherit; padding:6px 3px 6px 9px; }
  .title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
  .badge { color:var(--interactive-accent); font-size:10px; }
  .badge.waiting { color:var(--text-warning); font-weight:700; }
  .close, .new { border:0; background:transparent; color:var(--text-muted); border-radius:5px; }
  .close { margin-right:3px; width:22px; height:22px; }
  .new { flex:none; width:30px; height:28px; }
  .close:hover, .new:hover { background:var(--background-modifier-hover); color:var(--text-normal); }
  @media (max-width: 700px) { .cw-session-tabs { display:none; } }
</style>
