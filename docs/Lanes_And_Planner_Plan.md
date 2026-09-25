# Lanes, the Hydra panel and the Planner

Status: **plan** (2026-09-24). Agreed with Nico; to be built end to end.

## Goal

Hydra runs agents two ways:

| | **Heads** (built) | **Lanes** (new) |
| --- | --- | --- |
| Who drives | Hydra: your chat delegates, heads run on their own | You: each lane is a real `claude` or `codex` terminal you type into |
| Where you see it | Canvas | The Lanes grid (and a node on the canvas) |
| Isolation | Own worktree and branch | Own worktree and branch |
| Done means | Checks pass, the lead merges | You review the diff and merge (or open a PR) |

The Agents tab gets two views, **Canvas | Lanes**. The Hydra icon returns to the activity bar as a panel listing lanes, heads and plans. The **Planner** lets you draft a plan of jobs on the canvas (by hand, or from a brief that Claude or Codex splits for you) and run it as heads.

Out of scope, later: Gates (an independent reviewer run before a head counts as done), Packs, the Freebuff fallback, sending plan jobs to lanes instead of heads.

## 1. Lanes

### What a lane is

- A git worktree and branch `lane/<slug>-<id>` made from the main checkout's HEAD, in the same worktree root as heads (`hydra.worktreeRoot`, default `<repo>.worktrees`).
- An interactive `claude` or `codex` process in a real pseudo-terminal, running in that worktree with your own login and billing.
- Hydra's MCP server attached, so the agent can see the other lanes (`hydra_lanes`) and start heads. Heads a lane starts are grouped under that lane on the canvas.

### Record (`src/core/lanes.ts`, pure)

```ts
interface Lane {
  id: string;                 // 12 hex
  name: string;               // 1-40 chars
  provider: 'claude' | 'codex';
  goal?: string;              // <= 2000 chars
  repository: string;         // main checkout root
  worktree: string; branch: string; baseCommit: string;
  target: string;             // branch the main checkout was on when the lane started
  createdAt: string;
  state: 'running' | 'exited' | 'merged' | 'closed';
  exitCode?: number; mergedAt?: string;
}
```

Stored per window in `globalStorage/lanes.json` with the atomic-file helper. After an extension-host restart, `running` lanes become `exited` ("Hydra restarted"); their worktrees are untouched.

### Terminals (`src/core/lanePty.ts`)

- **Pty:** `node-pty`, loaded from the host application, not bundled: try `<appRoot>/node_modules/node-pty`, then `node_modules.asar.unpacked/node-pty`, then `node_modules.asar/node-pty` (`vscode.env.appRoot`). The Hydra desktop build and VS Code both ship it. If none loads, the Lanes view says "Terminals aren't available in this build" and nothing else breaks.
- **Wrapper:** a `LaneTerminal` over a small `PtyLike` interface (so tests use a fake), with:
  - output batched every 16 ms and kept in a 256 KB ring buffer, replayed when the webview (re)attaches;
  - `write`, `resize(cols, rows)`, `kill()`: on Windows a tree kill via `taskkill /T /F`, and the process-termination checks in `src/core/process.ts`;
  - an exit event with the exit code.
- **Launch:**
  - The executable comes from `findProvider`, and `.cmd` shims go through `processLaunch` (PowerShell `-EncodedCommand`, so no quoting bugs).
  - Environment: `process.env` plus `HYDRA_LANE_ID`, `HYDRA_LEAD_PROVIDER`, `HYDRA_HELPERS_DIR` (this window's helpers dir, as the heads bridge uses), `TERM=xterm-256color` and `COLORTERM=truecolor`.
  - If the provider is **not** connected to Hydra (`claudeStatus`/`codexStatus`), Hydra's server is passed for this process only: Claude gets `--mcp-config <temp json>`; Codex gets `-c mcp_servers.hydra.command=...` and `-c mcp_servers.hydra.args=[...]` (the same spec `helperServerSpec` builds). A connected provider already has it at user level.
  - With a goal, the first prompt is passed as a positional argument (see Coordination). Without one, the CLI starts empty.
  - Resume after exit or restart: Claude `--continue`; Codex `resume --last`. Each lane has its own folder, so "last in this folder" is this lane's conversation.
  - Starting size 100x30; the UI sends the real size.
- **Folder trust:** Claude and Codex may ask to trust the new worktree folder on first run. That is the user's own prompt, so Hydra doesn't answer or pre-accept it.

### MCP wiring

- **Discovery:** the window record's `folders` also lists open lanes' worktrees, rewritten when lanes change, so the bridge's `findWindowFor(cwd)` finds this window from inside a lane.
- **Lead session:** the bridge sends `lane: HYDRA_LANE_ID` (12 hex, else omitted) in the `lead-session` body. The endpoint keeps it on the caller only if that lane exists in this window. Heads started by that caller record `lead.lane` and `lead.label = lane name`. Lead verification is unchanged: the lane's process descends from the extension host, which is an allowed ancestor.
- **New lead tool `hydra_lanes`:** for any lead, including plain chats. It returns
  - `you` (the caller's lane id, if any);
  - `lanes[]`, each with `{ id, name, provider, goal, branch, state, changedFiles (<= 40), conflictsWith: [{ lane, files }], targetConflicts, behind, runningHeads }`.

  It forces a fresh sync before answering.
- **Instructions:** when `HYDRA_LANE_ID` is set, the bridge appends lane guidance to the lead instructions: "You are in Hydra lane *name* on branch *b*. Call hydra_lanes before you start and before large changes; avoid editing files other lanes are changing, and tell the user if you must." The same paragraph goes into `leadGuidanceMarkdown`, the Codex AGENTS.md block, for agents that don't read MCP instructions.

### Coordination (`src/core/laneSync.ts`)

Hydra warns and never blocks. Everything is deterministic git, with no model calls.

- **Snapshot:** a lane's current work (committed, staged, unstaged and untracked, honouring `.gitignore`) as a commit, without touching its real index or files:
  1. With a temporary `GIT_INDEX_FILE`: `read-tree HEAD`, then `add -A`, then `write-tree`.
  2. `commit-tree <tree> -p HEAD`.
  3. Delete the temporary index.
- **Changed files:** `git diff --name-only <baseCommit> <snapshot>`.
- **Lane vs lane:** `git merge-tree --write-tree --name-only --no-messages <snapA> <snapB>`. Exit 0 is clean; exit 1 lists the conflicted paths after the tree id. Any other result is an error, shown as "couldn't check".
- **Lane vs target:** the same check against the target branch tip, plus `behind = rev-list --count <laneHEAD>..<targetTip>`.
- **Cadence:**
  - Every 10 s while any lane is open.
  - Pairs whose two snapshots haven't changed are skipped (cached by snapshot ids).
  - `hydra_lanes` and the Lanes view's refresh force a sync.
- **Result per lane:** `sync: { changedFiles, conflicts: [{ laneId, files }], targetConflicts, behind, checkedAt, error? }`.
- **Goal preamble:** `lanePreamble(lane, others)` builds the first prompt as a single line: `You are working in Hydra lane "X" on branch lane/x. Other lanes in progress: Y (Codex): <goal, <= 80 chars>, files a, b, c; ... Call hydra_lanes to check again before large changes, and avoid editing files other lanes are changing. Your task: <goal>`.

### Finishing a lane

All git writes happen only on an explicit user action, each behind a confirmation where it matters.

- **Commit:**
  - Offered when the worktree is dirty.
  - The message is asked for, defaulting to "<name>: <first line of goal>".
  - Runs `git add -A` then `git commit` in the worktree.
- **Merge** (the default finish):
  - **Refused, with the reason:**
    - no commits beyond base: "Nothing to merge";
    - a dirty worktree: Hydra offers Commit first;
    - the main checkout isn't on `target`;
    - `targetConflicts` is non-empty: Hydra offers Update from *target* instead.
  - **Otherwise:**
    - A modal: "Merge lane X into main? 3 commits, 5 files. Merges cleanly."
    - Then `git merge --no-ff --no-edit <branch>` in the main checkout. If git refuses (for example, local changes in the main checkout), git's message is shown and nothing has changed.
    - The lane becomes `merged`, and Hydra offers Close.
    - The other lanes show "behind main".
- **Update from target:** `git merge --no-edit <target>` in the lane. On conflicts, the lane stays mid-merge, with the note "Conflicts in N files. Resolve them in the lane."
- **Open PR:**
  - `git push -u origin <branch>` from the worktree.
  - For a GitHub remote, then open `https://github.com/<owner>/<repo>/compare/<target>...<branch>?expand=1`. Otherwise show "Pushed <branch>".
- **Close:**
  - The pty is killed first.
  - **Merged lane:** `git worktree remove` (not forced), then `git branch -d`.
  - **Unmerged lane:** a modal with two choices:
    - **Keep branch:** commit any changes as "WIP: <name>", then remove the worktree.
    - **Delete everything:** force-remove the worktree, then `git branch -D`.
- **Removal safety:**
  - Hydra only removes a path that is a registered worktree **and** a known lane worktree under the worktree root.
  - Before a forced removal, it unlinks every junction or symlink directly inside the worktree (for example a linked `node_modules`), so removal can never delete through a link. This is the lesson from 2026-09-24.

### Extension-webview protocol

Webview to extension:

```ts
| { type: 'laneNew'; name: string; provider: 'claude' | 'codex'; goal?: string }
| { type: 'laneAttach' }                                   // after the Lanes view mounts: replay buffers
| { type: 'laneInput'; id: string; data: string }
| { type: 'laneResize'; id: string; cols: number; rows: number }
| { type: 'laneAction'; id: string; action: 'commit' | 'merge' | 'update' | 'pr' | 'close' | 'resume' | 'restart' | 'diff' | 'openWindow' | 'refresh' }
| { type: 'view'; view: 'canvas' | 'lanes'; focus?: string } // remember the view; focus a lane or head
```

Extension to webview:

```ts
| { type: 'lanes'; lanes: LaneView[]; terminals: boolean }   // LaneView = Lane + sync + running
| { type: 'laneData'; id: string; data: string }
| { type: 'laneReplay'; id: string; data: string }
| { type: 'laneError'; message: string }                     // for the New lane form
| { type: 'show'; view: 'canvas' | 'lanes'; focus?: string }
```

`parseMessage` validates each one: 12-hex lane IDs, name 1-40 chars, goal <= 2000, cols 20-500, rows 5-200, and input data <= 64 KB.

### Lanes view (`webview/LanesView.tsx`, `webview/lanes.css`)

- **Terminal:** xterm.js (`@xterm/xterm` + `@xterm/addon-fit`, bundled into the webview).
  - Themed from the VS Code terminal colour variables, with the terminal font family and size passed from the extension.
  - Scrollback 5000 lines.
- **Toolbar:** **New lane**, the lane count, and Refresh.
- **New lane form:** an inline card at the top of the grid with:
  - Name (default "Lane n");
  - Claude Code | Codex (default `hydra.defaultProvider`; disabled if not installed);
  - an optional Goal;
  - **Start lane**.

  Esc cancels; errors show inline.
- **Grid:**
  - `repeat(auto-fill, minmax(520px, 1fr))`, every tile a fixed 440 px tall, with the page scrolling vertically. There's no limit on count, and tiles never resize to their content.
  - At phone and narrow widths: one column.
- **Tile header:**
  - a status dot, the name, a provider badge and the branch (mono);
  - chips: amber "Conflicts with Lane 3 · src/cart.ts" (a tooltip lists all files), "3 behind main", green "Merges cleanly", "Merged".
- **Tile body:** the terminal. Clicking focuses it; while focused, keys go to the CLI.
- **Tile footer:**
  - "5 files changed" opens the diff;
  - buttons: **Diff**, **Merge**, and **...** (Commit..., Update from main, Open PR, Open in new window, Resume, Restart, Close lane...).
- **Exited:** an overlay on the terminal: "Session ended (code 0) · Resume · Start fresh".
- **Accessibility:**
  - Each tile is a labelled region. Buttons have names, and chips carry a text label as well as colour.
  - Reduced motion is respected.
  - High contrast works.
- **Diff:**
  - The multi-file diff (`vscode.changes`) of base against the worktree, the same way heads open diffs.
  - "Open in new window" opens the worktree folder in a new Hydra window.

## 2. Agents tab: Canvas | Lanes

- A segmented switch under the topbar: `Canvas | Lanes · n`. The chosen view is remembered in webview state, and each view gets the full space.
- Commands: `hydra.openCanvas` and `hydra.openLanes` (with an optional lane or head id to focus). `hydra.toggleMode` and Ctrl+Alt+A are unchanged.

### Canvas integration

- `buildCanvas(heads, lanes, plans, now)`: the leads are
  - chats with heads;
  - **every open lane**, even one with no heads;
  - every draft or running plan.
- Lane nodes:
  - A lane node is a lead node of kind `lane`, with the lane name, provider, and a status line: "Working · lane/x", "Conflicts with Lane 3", or "Exited".
  - Heads with `lead.lane === lane.id` group under it.
  - Conflicting lanes are joined by a red dashed `conflict` edge.
- Clicking a lane node switches to Lanes and scrolls to and focuses that tile.
- The empty text becomes "Lanes you open, plans you draft and heads your chats start will appear here."

## 3. The Hydra panel (activity bar)

- **Container:** `viewsContainers.activitybar`: `{ id: 'hydra', title: 'Hydra', icon: 'hydra-logo.png' }`, with one TreeView `hydra.overview`.
- **Groups:**
  - **Lanes:** each shows state, and the description "Claude · lane/x · conflicts". Clicking opens it in Lanes. Inline actions: Merge and Close.
  - **Heads:** the running heads, each with its status. Clicking focuses it on the canvas.
  - **Plans:** drafts and running plans. Clicking opens the canvas.
- **Title actions:** New lane (`+`), New plan, and Open Agents view.
- **Welcome view** (nothing yet): "Run several agents at once." with the buttons [New lane] [New plan] [Open Agents view].
- The tree refreshes on lane, head and plan changes.

## 4. Planner

### Model (`src/core/plans.ts`, pure)

```ts
interface Plan { id: string; title: string; brief?: string; createdAt: string;
  state: 'planning' | 'draft' | 'running' | 'done' | 'failed'; error?: string; jobs: PlanJob[] }
interface PlanJob { key: string; title: string; brief: string; provider?: Provider;
  dependsOn: string[]; writeScope?: string[]; jobId?: string /* set once started */ }
```

- **Validation:**
  - unique keys, and dependencies must exist;
  - at most 12 jobs, titles <= 80 chars, briefs <= 4000 chars;
  - `findCycle(jobs)` returns the cycle path, for example `['a', 'b', 'c', 'a']`.
- **Storage:** `globalStorage/plans.json`.

### Drafting on the canvas

- **New plan:**
  - The canvas toolbar opens an inline card with a Title and a Brief (textarea).
  - Two buttons:
    - **Plan with Claude/Codex** (the default provider);
    - **Start empty**.
- **Draft rendering:**
  - A draft plan is a lead node "Plan · <title>".
  - Its jobs are nodes with a dashed border and the status "Draft".
  - Plan-node actions: **+ Job**, **Run plan** and **Delete plan**.
- **Jobs:**
  - Click a job to edit it in a popover: title, brief, and provider (Auto, Claude or Codex).
  - Its context menu has Edit, Depends on... (a quick pick of the other jobs, multi-select) and Delete.
- **Edges:**
  - **Dependencies:** drag from a job's right-hand handle onto another job to add "that job depends on this one".
  - **Removing:** select an edge and press Delete, or use its context menu.
- **Cycles:** drawing is allowed. A live banner reads "The plan has a dependency cycle: A → B → C → A"; the cycle's edges turn red and **Run plan** is disabled while it lasts.

### Running

- **Run plan:**
  - Starts heads in topological order through `HelperService.startHelper` with:
    - the job's title, brief, provider and write scope;
    - `dependsOn` mapped to the started job ids;
    - a lead of `{ sessionId: 'plan-<id>', label: <title> }`.
  - Idempotent: jobs that already have a `jobId` are skipped, so running again after adding jobs starts only the new ones.
  - Jobs beyond the concurrency limit queue, as they already do.
- **Plan state:**
  - The plan becomes `running`.
  - Its heads show under the plan node, which now has the lead key `plan-<id>`.
  - When all its jobs finish it becomes `done`.

### Planning a brief

- **Run:** `claude -p --output-format json --permission-mode plan "<prompt>"`, or `codex exec --json --sandbox read-only "<prompt>"`, in the repository, through `processLaunch`.
  - Timeout 4 minutes; it can be cancelled from the plan node.
- **Prompt:** asks for JSON only: `{ "jobs": [{ "key", "title", "brief", "provider"?, "dependsOn": [], "writeScope": [] }] }`, with 2-8 jobs.
  - Each job must be independently doable with a complete brief and a narrow write scope, the same rules as heads.
- **Parsing:**
  - Take the first JSON object in the result text, validate it, and keep the plan `draft` for editing.
  - On failure the plan becomes `failed`, with the error, and "Retry" / "Start empty" offered.
- **While it runs:** the plan node shows "Planning with Claude...".

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | Lanes backend: lanes.ts, lanePty.ts, laneSync.ts, the finishing git operations, the MCP wiring (discovery folders, lead-session lane, `hydra_lanes`, instructions), extension commands and messages, unit tests with a fake pty and real temp git repos | **Opus**: native processes, git safety, the lead security path |
| 2 | Planner: plans.ts, storage, canvas draft editing, Run plan, brief planning, tests. Runs in parallel with 1 | **Sonnet** |
| 3 | The Lanes view (xterm grid, form, tiles), the Canvas \| Lanes switch, lane nodes and conflict edges on the canvas, the Hydra activity-bar panel. Built on 1, with 2 merged in | **Sonnet** |
| 4 | Integration, live probe verification (below), docs (README, Heads.md, this plan's "As built") | **Opus** |
| 5 | Local gate, PRs, CI, merge, light refresh of the installed app, ping Nico | **Opus** |

## Acceptance

**Unit tests:**
- Lane record validation and the restart transition.
- The pty loader's fallbacks (a missing module gives `terminals: false`).
- `LaneTerminal` batching, ring buffer, replay, resize and exit.
- Snapshot doesn't touch the index (the index hash is the same before and after), and it includes untracked files.
- Merge-tree clean and conflict cases against real temp repos.
- Merge refusals: dirty, nothing to merge, wrong branch, conflicts.
- Close safety: refuses unknown paths, and unlinks a junction before a forced removal (a temp junction survives with its target intact).
- `hydra_lanes` output.
- Bridge lane env to the lead-session body.
- `parseMessage` for every new message.
- `lanePreamble` has no newlines and is capped.
- Plans: cycle detection, topological order, idempotent run, and a planner output parser that handles fenced, noisy and invalid output.
- The canvas model with lanes and plans (layout and edges).
- SSR render of LanesView and the plan nodes.

**Smoke:**
- The Hydra panel is contributed.
- `hydra.openLanes` shows the Lanes view.
- A lane can be started with a harmless command in place of the CLI (test hook `HYDRA_TEST_LANE_COMMAND`); its output reaches the replay buffer, and closing it removes the worktree and branch.
- A plan with a cycle is refused.

**Live, in an isolated probe window with the real CLIs:**
1. The Hydra icon is in the activity bar; its tree shows lanes, heads and plans.
2. New lane (Claude, with a goal): the TUI renders in the tile, typing works, and the tile resize fits.
3. A second lane (Codex).
4. Both lanes edit the same file: conflict chips appear on both within about 10 s, and the canvas shows a conflict edge.
5. From lane 1, "call hydra_lanes" lists lane 2 with its files.
6. The Claude in lane 1 starts a head, and the head appears under the lane 1 node.
7. Merge lane 1: main has the commit; lane 2 shows behind or conflict; Update from main works.
8. Reload the window: the lanes show Exited, and Resume continues the conversation.
9. Close an unmerged lane with Delete everything: the worktree and branch are gone.
10. New plan from a brief: jobs appear; add a cycle and it's refused; fix it and Run, and heads appear under the plan node.

**Done** when the local gate passes (check, build, tests, smoke), the live checklist passes, the PRs are merged with CI green, the installed app is refreshed, and Nico has the summary.
