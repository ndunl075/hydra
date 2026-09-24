# Agents view: a live canvas of heads

Status: **built** (2026-09-24). Replaces the task-era Agents view. See "As built" at the end.

## What's wrong today

The Agents view (Ctrl+Alt+A, or the **Editor / Agents** status bar switch) was built for Hydra's first design, where Hydra ran its own "managed" Claude and Codex sessions as **tasks**:

- The map draws *tasks* (repository → worktree → agent) and only adds heads alongside them.
- Below it are the task list, "Resources and setup", "Managed CLI", profile slots and handoff buttons.

The work now happens in the official Claude Code and Codex extensions, which start Hydra heads. So the view shows empty or stale task machinery, and says little about what the agents are actually doing.

## What it should be

A single live canvas. It is **blank** when nothing is running. When a Claude Code or Codex chat starts heads, they **spread out** from that chat and are **drawn and removed as they work**. You see at a glance:

- which chat (the lead) started which heads;
- what each head is working on: title, current progress note, state;
- how heads connect: dependencies, and which ones wait on others;
- when a head finishes, its result: checks passed or failed, and changed files. It then leaves the canvas.

Everything on it comes from what Claude Code and Codex do in the editor. The view never starts work itself.

## Design

### Nodes

| Node | Appears when | Shows | Leaves when |
| --- | --- | --- | --- |
| **Lead** (a chat) | Its first head is created | Provider mark (Claude Code / Codex), chat label, count of active heads | Its last head has left, after a short grace period |
| **Head** | `hydra_start_head` creates the job | Title, provider, state chip (Queued, Working, Checking, Needs an answer, Done, Failed), latest `hydra_progress` note, write scope, elapsed time | Its branch is merged into the lead's folder, or it's cancelled or failed and dismissed; otherwise it fades after a timeout (see Open questions) |

### Edges

- **Lead → head**, animated while the head works, still once it finishes.
- **Head → head** dependency edges from `depends_on`. They're amber and dashed while the dependent waits, and turn solid when it's released.

### Motion

- **Spawn:** the head grows out of its lead's node along the edge, and the layout eases the other heads aside.
- **Work:** a gentle pulse on the state chip; the progress note cross-fades when it changes.
- **Finish:** the node settles, shows ✓ or ✕ with the check summary, then collapses back into the lead and disappears.
- **Empty state:** a quiet canvas with one line: "Heads your Claude Code and Codex chats start will appear here."
- Honours reduced motion: no travel animation, just state changes. A **Pause motion** control stays.

### Layout

- A radial-ish tree per lead: the lead on the left or centre, heads fanned out, with dependents placed after what they depend on. Multiple leads stack vertically.
- Positions are computed deterministically from the graph, with no physics simulation, so nothing jitters. Only new or removed nodes animate.
- Pan and zoom stay. Clicking a head opens its diff (the existing `helperReview`). Its context menu has Open log, Cancel, and Answer question (for a blocked head).

### Side panel (replaces the task list)

A narrow list of the same heads, for keyboard and screen-reader use: title, state, lead, elapsed time. It filters to "Running" or "All today". Selecting a row highlights the node.

## What has to change underneath

1. **Know which chat started which head.** Jobs carry only `leadKey`, which is per window. Two changes:
   - The lead-session handshake issues a **lead session id** per bridge process (one per chat), and `hydra_start_head` records it on the job (`leadSessionId`).
   - The bridge reports its **provider**. Connect sets `HYDRA_LEAD_PROVIDER=claude` or `codex` in each registration's env. The verifier's process chain (`claude.exe` or `codex.exe` in the parents) is a cross-check.
2. **A live event stream.** The snapshot already includes heads, but the canvas needs changes as they happen: created, state changed, progress, merged. Post head events to the webview from `HelperService`/`JobStore` transitions, rather than polling the full snapshot.
3. **Merge detection.** When a head is done, check whether its commit is an ancestor of the lead folder's HEAD (`git merge-base --is-ancestor`). Recheck on the lead folder's git state changes. That's what lets a finished head leave the canvas.
4. **Retire the task machinery from this view.** Remove the task list, "Resources and setup", "Managed CLI", profile slots and handoff from the Agents view.
   - Managed tasks were already hidden as a delegation path (Official_Extensions_Plan Phase 1).
   - Their code can go in a follow-up once nothing depends on it. The smoke suite covers managed sessions, so removing them is its own PR.

## Phases

| Phase | Work | Size | Model |
| --- | --- | --- | --- |
| 1 | Lead session id and provider on jobs; head event stream to the webview; merge detection. Unit tests for each. | Medium | **Sonnet** (bounded, test-driven) |
| 2 | New canvas component: nodes, edges, deterministic layout, spawn/finish/remove motion, empty state, reduced motion. Replaces `AgentMap` in the Agents view. | Large | **Opus** for the layout and motion design, then Sonnet to finish |
| 3 | Side list, context actions (diff, log, cancel, answer), keyboard navigation, accessibility labels. | Medium | **Sonnet** |
| 4 | Remove the task list and managed-task panels from the Agents view; keep the Editor mode as is. Update smoke tests. | Medium | **Sonnet** |
| 5 | Probe verification: start real heads from Claude Code and Codex and record the canvas spawning, working and clearing. Update docs/Heads.md and the README. | Small | **Sonnet** |

Each phase goes through the local gate, a PR, and Nico's OK before merge.

## Open questions

- **When a finished head leaves** if its branch is never merged: after 2 minutes? When dismissed? Or does it stay in a "Finished" tray at the edge of the canvas? Proposal: fade to a small tray chip after 2 minutes; click to reopen.
- **Lead label:** the extensions don't expose a chat's title. Use "Claude Code chat" / "Codex chat" plus the time it started, unless the lead passes a label on its first `hydra_start_head` (a new optional `lead_label` field the instructions could ask for).
- **Multiple windows:** the canvas shows only this window's heads, as the job store already scopes them.

## Later: long-running tasks

Not in this plan. A separate lane or tray for work that runs for hours (background builds, long migrations, scheduled heads) may come later. The canvas is for heads that come and go within a session. Long-running work needs its own view with progress, logs and resumability.

## As built

- **Phase 1:**
  - **Chat identity:** a lead's token names its session. The lead-session handshake issues a 12-hex session id per bridge process, and the bridge declares its provider. Connect sets `HYDRA_LEAD_PROVIDER` in each agent's registration; without it, the process chain decides (`chainProvider`: `claude.exe` / `codex.exe`).
  - **On the job:** `hydra_start_head` records `lead: { sessionId, provider, label }`. `lead_label` is a new optional tool field.
  - **Events and merges:** head changes post a `heads` event to the webview at once, and the full snapshot follows, debounced. `HelperService.refreshMerged` runs with the watchdog every 5 s and checks each done head's commit with `git merge-base --is-ancestor <commit> HEAD` in the lead folder.
  - **Registration fix:** Claude registration retries once when a concurrent Hydra window re-added its entry ("already exists").
- **Phase 2:**
  - `src/core/agentsCanvas.ts` is the pure model:
    - visibility: working, or finished within 2 minutes and not merged;
    - the tray: unmerged results from the last 12 hours;
    - grouping by chat, and a deterministic layout where dependents sit to the right;
    - edges: `waiting` while a dependent is queued behind a working head.
  - `webview/AgentsCanvas.tsx` draws it:
    - motion: heads grow out of their chat and collapse back when they leave; layout moves are CSS transitions, and edges animate `d`;
    - navigation: pan, Ctrl+wheel zoom, and Pause motion;
    - accessibility: reduced motion and high contrast are respected.
- **Phase 3:**
  - Side list: Running / All today. Selecting a head centres it on the canvas.
  - Actions: Open diff, Open log, **Answer question…** (new `helperAnswer`: an input box; Hydra replies on the lead's behalf), Cancel head, and Stop all heads.
  - Keyboard: each head is focusable. Enter opens the diff, Shift+F10 or ContextMenu opens the menu, and ↑/↓ move between heads.
- **Phase 4:**
  - The Agents page is now the header plus the canvas; the handoff window keeps its view.
  - The task list, "Resources and setup", "Managed CLI", profile slots and the new-task form are gone from it.
  - `AgentMap` and `HelperDashboard` were deleted; the managed-task components stay in the tree for the follow-up removal.
  - Tests moved to `tests/agentsCanvas.test.ts`.
- **Phase 5:**
  - Verified live in the probe: a real Claude Code lead, run from a terminal inside Hydra, started three heads, one of them Codex, with a dependency.
  - The canvas showed:
    1. them growing out of the chat;
    2. Working and Queued ("Waiting for what it depends on") states;
    3. amber dependency edges;
    4. Done with "1/1 checks passed · 1 file changed".
  - After the lead merged the branches, all three left the canvas.
  - Two layout bugs found in that run were fixed: row spacing below the card height, and the viewport scrolling on focus (now `overflow: clip`).
- **Found in the live runs and fixed:**
  - Cards overlapped vertically: rows are now 172px apart, and a test pins it.
  - The viewport scrolled when something inside took focus: it's now `overflow: clip`.
  - In a short pane (for example with the terminal open), heads were out of view:
    - The canvas now **fits all heads** into the space it has, until you zoom or pan. The **Fit** button goes back to fitting.
    - The Finished tray sits below the canvas instead of over it.
    - When stacked, the side list takes at most about a third of the height.
  - Heads that left weren't always cleared, which kept the empty message hidden. Clearing now runs on the canvas's own clock, not a timer a re-render could cancel.
  - A chat now stays about a second after its last head folds back into it, then fades (the plan's "short grace period").
  - A headless-browser harness drove the real component through empty → two heads → merged → empty and confirmed each step, with no errors.
- **Not done:**
  - Removing the managed-task code from the tree is the planned follow-up.
  - Codex was tested as a head (started by a Claude lead), not as a lead itself: its lead provider tag is covered by unit tests, and in real use comes from the Connect registration.
