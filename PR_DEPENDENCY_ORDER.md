# PR dependency order (personal fork tracking)

Internal tracking doc for `takeshi-teshima/obsidian-chatting` (this fork's own
repo) — **not** part of the upstream-facing `README.md`, which stays focused
on the plugin itself. Lives on `personal/main` (the single "everything"
branch this account's fork develops against).

## What this is

`personal/main`'s entire history is one long **linear chain** — every branch
below is a checkpoint on that same line, each one stacked directly on top of
the previous branch's tip. There is no real branching topology: branch N+1
was always created from branch N's tip, so **PR #k's base is always PR
#(k-1)'s head**, in the exact order listed below, with two standalone
exceptions (`feat/pdf-tools`, `feat/reload-session`) that branch directly off
`main` instead and are unrelated to the rest of the chain.

Because of this, **the merge order is not a choice — it is the only order
that will ever apply cleanly**. Merging out of order (e.g. #25 before #24)
will fail or silently duplicate/skip commits, since each PR's diff only makes
sense relative to its specific base.

## Merge order (top of table = merge first)

| # | PR | Base ← Head | Summary |
|---|----|-------------|---------|
| 1 | [#1](https://github.com/takeshi-teshima/obsidian-chatting/pull/1) | `main` ← `feat/model-capabilities` | Centralize model capabilities (+ PDF tools rebuild, reload button) |
| 2 | [#2](https://github.com/takeshi-teshima/obsidian-chatting/pull/2) | `feat/model-capabilities` ← `feat/reasoning-effort` | Add configurable reasoning effort |
| 3 | [#3](https://github.com/takeshi-teshima/obsidian-chatting/pull/3) | `feat/reasoning-effort` ← `feat/custom-instructions` | Add custom instructions and agent operating defaults |
| 4 | [#4](https://github.com/takeshi-teshima/obsidian-chatting/pull/4) | `feat/custom-instructions` ← `feat/skills` | Add progressive-disclosure skills |
| 5 | [#5](https://github.com/takeshi-teshima/obsidian-chatting/pull/5) | `feat/skills` ← `feat/prompt-profiles` | Add markdown prompt profiles |
| 6 | [#6](https://github.com/takeshi-teshima/obsidian-chatting/pull/6) | `feat/prompt-profiles` ← `feat/context-ref` | Add provider-neutral context references |
| 7 | [#7](https://github.com/takeshi-teshima/obsidian-chatting/pull/7) | `feat/context-ref` ← `feat/pdf-mentions` | Add local PDF mentions |
| 8 | [#8](https://github.com/takeshi-teshima/obsidian-chatting/pull/8) | `feat/pdf-mentions` ← `feat/provider-vision` | Add provider-native image input |
| 9 | [#9](https://github.com/takeshi-teshima/obsidian-chatting/pull/9) | `feat/provider-vision` ← `feat/image-mentions` | Add image mentions |
| 10 | [#10](https://github.com/takeshi-teshima/obsidian-chatting/pull/10) | `feat/image-mentions` ← `feat/attachment-ui` | Add image paste and attachment ingestion |
| 11 | [#11](https://github.com/takeshi-teshima/obsidian-chatting/pull/11) | `feat/attachment-ui` ← `feat/session-persistence` | Add multi-session persistence *(later fully reverted further down the chain — kept for history, see #12/#13)* |
| 12 | [#12](https://github.com/takeshi-teshima/obsidian-chatting/pull/12) | `feat/session-persistence` ← `feat/session-workspaces` | Restore reload-from-disk recovery for oversized session history *(range also contains the revert of #11's approach and the first "session workspaces v3" attempt, itself later reverted — see #13)* |
| 13 | [#13](https://github.com/takeshi-teshima/obsidian-chatting/pull/13) | `feat/session-workspaces` ← `feat/session-workspaces-v4` | Add session workspaces v4 (Claudian-compatible storage) *(range also contains the revert of v3)* |
| 14 | [#14](https://github.com/takeshi-teshima/obsidian-chatting/pull/14) | `feat/session-workspaces-v4` ← `feat/session-workspaces-v4-complete` | Add multi-session runtime/browsing UI and pane-layout observer wiring |
| 15 | [#15](https://github.com/takeshi-teshima/obsidian-chatting/pull/15) | `feat/session-workspaces-v4-complete` ← `feat/responsive-chat-shell` | Add responsive chat shell (container-width-based layout) |
| 16 | [#16](https://github.com/takeshi-teshima/obsidian-chatting/pull/16) | `feat/responsive-chat-shell` ← `feat/turn-model-selection` | Add turn-level model/reasoning selection |
| 17 | [#17](https://github.com/takeshi-teshima/obsidian-chatting/pull/17) | `feat/turn-model-selection` ← `feat/claudian-model-selection-ownership-ui` | Add Claudian-style model selection ownership and UI |
| 18 | [#18](https://github.com/takeshi-teshima/obsidian-chatting/pull/18) | `feat/claudian-model-selection-ownership-ui` ← `feat/simplify-clear-reload` | Remove redundant Clear button, make session reload automatic on open |
| 19 | [#19](https://github.com/takeshi-teshima/obsidian-chatting/pull/19) | `feat/simplify-clear-reload` ← `feat/claudian-model-selection` | Persist the model catalog to ChatSettings |
| 20 | [#20](https://github.com/takeshi-teshima/obsidian-chatting/pull/20) | `feat/claudian-model-selection` ← `feat/enter-to-send-setting` | Make Enter-to-send configurable |
| 23 | [#23](https://github.com/takeshi-teshima/obsidian-chatting/pull/23) | `feat/enter-to-send-setting` ← `feat/title-generation` | Add Claudian-style automatic conversation title generation |
| 24 | [#24](https://github.com/takeshi-teshima/obsidian-chatting/pull/24) | `feat/title-generation` ← `feat/model-catalog-manage-ui` | Replace flat model catalog rows with a dedicated management modal |
| 25 | [#25](https://github.com/takeshi-teshima/obsidian-chatting/pull/25) | `feat/model-catalog-manage-ui` ← `feat/model-catalog-drag-reorder` | Replace up/down reorder buttons with a drag handle in the model catalog modal |
| 26 | [#26](https://github.com/takeshi-teshima/obsidian-chatting/pull/26) | `feat/model-catalog-drag-reorder` ← `fix/settings-normalize-field-loss` | Fix: stop silently dropping newer settings fields on every plugin reload |
| 27 | [#27](https://github.com/takeshi-teshima/obsidian-chatting/pull/27) | `fix/settings-normalize-field-loss` ← `feat/model-catalog-sortablejs` | Fix: replace hand-rolled drag reorder with SortableJS (was non-functional on desktop) |
| 28 | [#28](https://github.com/takeshi-teshima/obsidian-chatting/pull/28) | `feat/model-catalog-sortablejs` ← `fix/default-model-newbtn-title-digest` | Fix: catalog order wins for new-chat default model; disable "+" on a pristine session; title generation digests the whole conversation |
| 29 | [#29](https://github.com/takeshi-teshima/obsidian-chatting/pull/29) | `fix/default-model-newbtn-title-digest` ← `feat/model-capability-manual-override` | Add manual reasoning-effort override for models the name-based heuristic doesn't recognize |
| 30 | [#30](https://github.com/takeshi-teshima/obsidian-chatting/pull/30) | `feat/model-capability-manual-override` ← `feat/session-index-conflict-quarantine` | Quarantine and rebuild the session index when sync-conflict files appear |
| 31 | [#31](https://github.com/takeshi-teshima/obsidian-chatting/pull/31) | `feat/session-index-conflict-quarantine` ← `fix/session-index-rebuild-guard` | Never let a transient empty rebuild source wipe a known-non-empty session index |

`fix/session-index-rebuild-guard` (PR #31's head) is `personal/main`'s
current tip. Merging #1 through #31 in order is equivalent to fast-forwarding
`main` to `personal/main` in one shot.

## Standalone (not part of the chain above)

These two branch directly off `main` and have no relationship to the chain
or to each other. They can be merged independently, in any order, before or
after the chain above:

| PR | Base ← Head | Summary |
|----|-------------|---------|
| [#21](https://github.com/takeshi-teshima/obsidian-chatting/pull/21) | `main` ← `feat/pdf-tools` | Add mobile-first local PDF tools |
| [#22](https://github.com/takeshi-teshima/obsidian-chatting/pull/22) | `main` ← `feat/reload-session` | Add Reload button to re-sync chat state from disk |

## Practical notes

- **GitHub's PR UI will happily let you merge these out of order** — it
  doesn't know about this dependency chain, it only checks the base/head
  pair of the PR you're clicking. Nothing enforces the order except this
  document.
- If you merge #1 first (base=`main`, head=`feat/model-capabilities`) via a
  normal GitHub merge, `main` now contains everything through
  `feat/model-capabilities`. PR #2's base branch (`feat/model-capabilities`)
  is unaffected by that merge, so #2 remains mergeable next — and so on down
  the table. This is why the order above is safe as a straight top-to-bottom
  merge queue.
- Some ranges (#12, #13) contain reverted work from earlier in the same
  range — that's real history (an approach was tried, reverted, and replaced
  further down the chain), not a mistake to squash away.
- This file itself should be kept in sync whenever a new branch is stacked
  on `personal/main`'s tip and PR'd — append a new row rather than editing
  past ones.
