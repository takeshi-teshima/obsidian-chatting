<script lang="ts">
  import type { SessionQueryResult, SessionRunPhase, SessionSummary } from "../../session/types";
  import { buildSessionBrowserSections, formatRelativeSessionTime } from "../../session/browser-model";

  export let result: SessionQueryResult;
  export let currentSessionId: string | null = null;
  export let scope: "active" | "pinned" | "archived" = "active";
  export let search = "";
  export let sort: "activity" | "created" = "activity";
  export let runtimePhases: ReadonlyMap<string, SessionRunPhase> = new Map();
  export let activeCount = 0;
  export let pinnedCount = 0;
  export let archivedCount = 0;
  export let onScope: (scope: "active" | "pinned" | "archived") => void;
  export let onSearch: (value: string) => void;
  export let onSort: (sort: "activity" | "created") => void;
  export let onOpen: (id: string) => void;
  export let onNew: () => void;
  export let onLoadMore: () => void;
  export let onActions: (id: string, event: MouseEvent) => void;
  export let groupByDate = true;

  $: sections = buildSessionBrowserSections(result, runtimePhases, groupByDate);

  function phaseFor(id: string): SessionRunPhase { return runtimePhases.get(id) ?? "idle"; }
  function phaseLabel(phase: SessionRunPhase): string {
    if (phase === "running") return "Running";
    if (phase === "queued") return "Queued";
    if (phase === "waiting_user") return "Needs input";
    if (phase === "stopping") return "Stopping";
    return "";
  }
</script>

<section class="cw-session-browser" aria-label="Conversations">
  <header>
    <div class="heading"><strong>Conversations</strong><button type="button" class="new" on:click={onNew}>New</button></div>
    <input
      aria-label="Search conversations"
      placeholder="Search title, preview, model…"
      value={search}
      on:input={(e) => onSearch((e.currentTarget as HTMLInputElement).value)}
    />
    <div class="tabs" role="tablist">
      <button class:active={scope === "active"} on:click={() => onScope("active")}>Recent <span>{activeCount}</span></button>
      <button class:active={scope === "pinned"} on:click={() => onScope("pinned")}>Pinned <span>{pinnedCount}</span></button>
      <button class:active={scope === "archived"} on:click={() => onScope("archived")}>Archive <span>{archivedCount}</span></button>
    </div>
    <label class="sort">Sort
      <select value={sort} on:change={(e) => onSort((e.currentTarget as HTMLSelectElement).value as "activity" | "created")}>
        <option value="activity">Last activity</option>
        <option value="created">Created</option>
      </select>
    </label>
  </header>

  <div class="list">
    {#if result.items.length === 0}
      <div class="empty">No conversations found.</div>
    {/if}
    {#each sections as section (section.key)}
      {#if groupByDate && section.label}<div class="section-label">{section.label}</div>{/if}
      {#each section.rows as item (item.id)}
        {@const phase = phaseFor(item.id)}
        <article class:current={item.id === currentSessionId} class:unread={item.hasUnreadActivity}>
          <button class="open" type="button" on:click={() => onOpen(item.id)}>
            <div class="row1">
              {#if item.isPinned}<span title="Pinned">★</span>{/if}
              {#if item.hasUnreadActivity}<span class="dot" aria-label="Unread"></span>{/if}
              <strong>{item.title}</strong>
              <time>{formatRelativeSessionTime(item.lastActivityAt)}</time>
            </div>
            <div class="preview">{item.preview || "No messages yet"}</div>
            <div class="meta">
              {#if phase !== "idle"}<span class:waiting={phase === "waiting_user"} class="phase">{phaseLabel(phase)}</span>{/if}
              <span>{item.messageCount} msgs</span>
              <span>{item.preferences.model}</span>
            </div>
          </button>
          <button class="more" type="button" aria-label={`Actions for ${item.title}`} on:click={(e) => onActions(item.id, e)}>⋯</button>
        </article>
      {/each}
    {/each}
    {#if result.nextOffset !== null}
      <button class="load" type="button" on:click={onLoadMore}>Load more ({result.total - result.nextOffset} remaining)</button>
    {/if}
  </div>
</section>

<style>
  .cw-session-browser { height:100%; display:flex; flex-direction:column; min-width:0; background:var(--background-primary); }
  header { padding:10px; border-bottom:1px solid var(--background-modifier-border); display:flex; flex-direction:column; gap:8px; }
  .heading { display:flex; align-items:center; justify-content:space-between; }
  .new { border:0; border-radius:6px; padding:5px 9px; background:var(--interactive-accent); color:var(--text-on-accent); }
  input { width:100%; box-sizing:border-box; }
  .tabs { display:flex; gap:3px; }
  .tabs button { flex:1; border:0; border-radius:6px; padding:5px; background:transparent; color:var(--text-muted); }
  .tabs button.active { background:var(--background-modifier-hover); color:var(--text-normal); }
  .tabs span { opacity:.7; font-size:11px; }
  .sort { font-size:11px; color:var(--text-muted); display:flex; align-items:center; justify-content:flex-end; gap:6px; }
  .list { overflow:auto; padding:5px; min-height:0; }
  .section-label { position:sticky; top:0; z-index:1; padding:7px 8px 4px; background:var(--background-primary); color:var(--text-faint); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  article { position:relative; display:flex; border-radius:7px; margin:1px 0; }
  article:hover, article.current { background:var(--background-modifier-hover); }
  article.unread strong { color:var(--text-accent); }
  .open { flex:1; min-width:0; border:0; background:transparent; text-align:left; padding:8px 30px 8px 8px; color:var(--text-normal); }
  .row1 { display:flex; align-items:center; gap:5px; min-width:0; }
  .row1 strong { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  time { color:var(--text-faint); font-size:10px; flex:none; }
  .preview { color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; margin-top:3px; }
  .meta { display:flex; gap:6px; color:var(--text-faint); font-size:10px; margin-top:4px; }
  .phase { color:var(--text-accent); }
  .phase.waiting { color:var(--text-warning); }
  .dot { width:6px; height:6px; border-radius:50%; background:var(--interactive-accent); flex:none; }
  .more { position:absolute; right:3px; top:6px; border:0; background:transparent; border-radius:5px; color:var(--text-muted); }
  .more:hover { background:var(--background-modifier-hover); }
  .load { width:100%; border:0; padding:9px; background:transparent; color:var(--text-accent); }
  .empty { padding:30px 10px; text-align:center; color:var(--text-muted); }
</style>
