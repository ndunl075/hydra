# Hydra heads

You chat with Claude in the Claude Code extension, or with Codex in the Codex extension. When a task has independent pieces, the agent hands them to **Hydra heads**: separate agents that Hydra runs in their own git worktrees, checks, and hands back. The agent you're chatting with is the **lead**, and it merges the heads' work with git.

You don't have to ask for heads. Hydra tells the lead to decide by itself: before a code change, it checks whether the work splits into independent pieces with separate files (a feature and its tests, frontend and backend, several unrelated fixes). If there are two or more pieces worth a few minutes each, it starts one head per piece without asking or announcing it; the heads appear on Hydra's Agents view. Small, tightly coupled or question-only tasks stay with the lead. You can still ask for heads, or ask it not to use them.

This replaces the old Auto delegation, which read a `HYDRA_DELEGATION_V1` line out of chat text. How it was designed and verified is in [Official_Extensions_Plan.md](Official_Extensions_Plan.md).

## Connecting Claude Code and Codex

Connect in onboarding (step 03, Providers) or in **Hydra Settings → Connectors**, which also shows the exact entries Hydra wrote and has a **Repair** button for claude-mem. Each agent has one row with a single **Connect to Hydra** button:

1. It installs the official extension if it's missing. It uses the extension gallery, or downloads straight from Open VSX when the editor has none.
2. It connects the extension to Hydra.
3. For Claude, it also sets up [claude-mem](https://github.com/thedotmack/claude-mem) memory:
   - installs Bun into `~/.bun/bin` from Bun's official release, if missing;
   - installs claude-mem through `claude plugin` if missing, or updates it;
   - installs claude-mem's dependencies.

Hydra redistributes neither Bun nor claude-mem. The row also has Disconnect and Sign in. Claude Code and Codex keep their own sign-in and billing.

Connecting adds Hydra as a user-level tool server named `hydra`. That's per user, never per project; nothing is written inside a repository.

| Agent | What Hydra writes | Undone by Disconnect |
| --- | --- | --- |
| Claude Code | `claude mcp add-json -s user hydra …` (stored by Claude in `~/.claude.json`), and an `"mcp__hydra"` allow rule in `~/.claude/settings.json` | Yes. `settings.json` is restored byte for byte |
| Codex | A marked `[mcp_servers.hydra]` block at the end of `~/.codex/config.toml`, and a marked "Hydra heads" block with the same delegation guidance at the end of `~/.codex/AGENTS.md` (Codex may not read MCP instructions) | Yes. Both files are restored byte for byte; an `AGENTS.md` that Hydra created is removed |

- **What the tool server is:** `dist/hydra-mcp.cjs`, run by Hydra's own executable with `ELECTRON_RUN_AS_NODE=1`, so Node doesn't need to be installed.
- **Hydra updates:** if an update moves Hydra's executable, Hydra refreshes an existing connection on its next start. It never connects anything you didn't.
- **When heads are available:** only while a Hydra window has that folder open. Otherwise the actions answer "Hydra isn't open for this folder".

## What the agents can do

**The lead:**

| Action | What it does |
| --- | --- |
| `hydra_start_head` | Start a head, given `title`, `brief`, `write_scope` (repository paths it may change), `idempotency_key`, and optionally `provider`, `model`, `depends_on` and `limits`. Returns a job id at once. A repeated key returns the same job instead of starting another. |
| `hydra_wait_for_heads` | Wait until the heads finish or ask a question, then return their results. It keeps the lead's turn open; Claude and Codex both resume by themselves when it returns. `max_wait_s` defaults to 1800. |
| `hydra_get_head` / `hydra_list_heads` | State, summary, branch, commit, changed files and check results. |
| `hydra_reply_to_head` | Answer a head that asked a question. |
| `hydra_cancel_head` | Stop a head. Its branch is kept. |

**A head:**

| Action | What it does |
| --- | --- |
| `hydra_done` | Report the work finished. Hydra commits anything left uncommitted, refuses changes outside the write scope, and runs the checks, all inside the call. If something fails, the head is told what to fix, with up to 3 attempts. |
| `hydra_stuck` | Ask the lead one question. The call waits, and the lead's answer comes back as its result. |
| `hydra_progress` | A short note for the dashboard. |

## Lifecycle

```
queued → starting → running → checking → done
                       ⇅          │
                    blocked       └→ running (checks failed, attempts left)
any unfinished state → failed or cancelled
```

- **The state table:** every change is checked against one allowed-transitions table in `src/core/jobs.ts`, written atomically, and kept in the job's history.
- **Queueing:** heads wait in a queue up to `hydra.maxConcurrentHelpers` (default 3). A head whose dependency failed or was cancelled fails too.
- **Silent stops:** a head that stops without calling `hydra_done` or `hydra_stuck` is nudged once, then failed. A head process that exits is failed.
- **After a restart:** heads that were running are failed with the reason, because no head process survives a restart.

## Limits and permissions

- **Starting point:** each head gets a new worktree and branch from the lead folder's **current HEAD**. If that folder has uncommitted changes, the lead is warned that the head won't see them.
- **Limits** (the lead can change them per job): by default 30 minutes of work (time spent waiting for an answer doesn't count), 60 turns and 5 USD. Change the defaults in **Hydra Settings → Heads**. The turn and cost caps apply to Claude only.
- **No permission prompts:** heads never ask anyone.
  - **Claude:** `--permission-mode dontAsk` with an allowed-tools list (file tools, Bash/PowerShell, and Hydra's head actions; no web tools). Anything else is denied and the head carries on. Your user-level allow rules in `~/.claude/settings.json` also apply to heads.
  - **Codex:** `codex exec` with the `workspace-write` sandbox and approval `never`. On Windows that sandbox blocks writes to a worktree's `.git` metadata, which is why Hydra does the commit.
- **Stop everything:** **Hydra: Stop All Heads** in the command palette, **Stop all heads** in **Hydra Settings → Heads**, or **Stop all** on the dashboard.

## When a provider hits its limit

A head that hits its provider's usage limit fails at once, with that as its reason. It doesn't spend a check attempt and it isn't nudged — the limit isn't its fault. The same detection covers a Claude Code or Codex chat in the official extension hitting its own limit.

Either way Hydra shows one notification: which provider hit its limit (and when it resets, if known) and a **Continue in <Other provider>** button (**Set up <Other provider>** instead, if it isn't connected yet), plus **View handoff** and **Wait**. The handoff — the ask, files touched, git state, and what looked unfinished — is assembled mechanically (no model call) and saved under Hydra's global storage, not in the repository.

For a head, **Continue in** switches its provider and restarts it **in the same worktree and branch**, with the handoff appended to its brief, so partial work isn't lost. The lead sees it running again through `hydra_wait_for_heads` like any other head. For a chat, Hydra copies the handoff to the clipboard and opens the other provider's chat (Hydra never types into it); paste the handoff there to continue. Turn the notification off with `hydra.limits.offerHandoff`.

## Gates

No agent grades its own work. When a head calls `hydra_done`, its changes pass the scope check and then this project's **gates** before they're accepted ([Gates_Plan.md](Gates_Plan.md)).

**Where gates come from:** the **lead's** folder, never a head's worktree, so a head can't edit them away. Put them in `.hydra/gates.json`, or edit them in **Hydra Settings → Gates**:

```json
{
  "maxAttempts": 3,
  "lanes": "onMerge",
  "gates": [
    { "id": "unit", "type": "command", "command": ["npm", "test"], "timeoutSeconds": 600 },
    { "id": "ui", "type": "screenshots", "start": ["npm", "run", "dev", "--", "--port", "{port}"], "url": "http://localhost:{port}/", "widths": [390, 768, 1280], "required": false },
    { "id": "review", "type": "review", "reviewer": "other" }
  ]
}
```

**The three kinds:**
- **command:** runs in the head's worktree and must exit 0.
- **screenshots:** Hydra starts your app on a free port (it replaces `{port}` and sets `PORT`), then captures each width in a headless Edge or Chrome. The gate fails on a page that never gets ready, HTTP errors, console errors or an empty page.
- **review:** a second agent reviews the brief and the diff read-only. By default it's the other agent: Codex reviews Claude's work, and the other way round. Only blocker or major findings fail it.

**How results are handled:**
- **Order:** gates run as command, then screenshots, then review. Once a required gate fails, the rest are skipped.
- **Not blocking:** `required: false` gates are reported but never block.
- **Not run:** a reviewer or browser that can't run (not installed, rate-limited, timed out) marks its gate **not run**. That never fails the head.
- **Failures:** they go back to the head with the output and findings, up to `maxAttempts`.

**Seeing the results:** gate chips (**✓ unit · ✓ ui · ✗ review**) sit on the head's card. **View evidence** in its menu opens the output, findings (linked to file:line) and screenshots.

**Compatibility:** an older `.hydra/checks.json` still works, read as command gates. With neither file, a head is accepted after the scope check.

**What a head starts from:**
- **Dependencies:** a head with `depends_on` starts from the finished work of the heads it waited on, merged into one commit when there are several. Its brief includes their summaries. If they conflict, it fails before starting and names the files.
- **Lanes:** a head started from a lane starts from the lane's latest commit.

## The Agents view

Open it with **Ctrl+Alt+A**, or **Agents** in the status bar. It's a live canvas of your heads ([Agents_View_Plan.md](Agents_View_Plan.md)):

- **Blank until a chat starts heads.** Each head grows out of the chat that started it: the **lead**, labelled with its provider, and a name if the chat gave one (`lead_label`).
- **What each head is doing:** state (Queued, Working, Needs an answer, Checking, Done, Failed), its latest progress note or question, branch and elapsed time. When it finishes: checks passed and files changed.
- **How heads connect:** a flowing edge from the chat while a head works, and amber dependency edges (`depends_on`) between heads. A dependent sits to the right of what it waits on.
- **Heads leave when they're merged.** Hydra notices within seconds when a head's commit is in your folder's HEAD, and the head collapses back into its chat. A finished head that isn't merged stays two minutes, then moves to the **Finished** tray. **Clear** empties the tray; new results still show up. A lane that has been exited for 10 minutes, with no heads running, moves to the **Parked lanes** strip; click it to open the lane.
- **Actions** (click the ⋯ on a head, right-click, or Shift+F10): **Open diff**, **Open log** (token removed), **Answer question…** for a head waiting on the lead, and **Cancel head**. **Stop all heads** is in the toolbar.
- **Heads list** on the side: Running, or All today. Selecting a head centres it on the canvas; Enter opens its diff.
- **Pause motion**, zoom (Ctrl+wheel) and drag to pan. Reduced-motion and high-contrast settings are respected.

Apart from plans (below), the view never starts work itself; everything else on it comes from what your Claude Code and Codex chats do.

### Plans

**New plan** (in the canvas toolbar, or **Hydra: New Plan**) lets you set the jobs up yourself before any head starts ([Lanes_And_Planner_Plan.md](Lanes_And_Planner_Plan.md), section 4):

- **Plan with Claude or Codex:** give a title and a brief. Your default provider reads the repository in read-only mode and splits the brief into 2–8 jobs. **Start empty** adds the jobs by hand instead.
- **Edit the draft on the canvas:**
  - Click a job to change its title, brief or provider.
  - Drag from a job's ⋮ handle onto another job to make that job depend on it.
  - Right-click an edge, or select it and press Delete, to remove it.
  - Right-click a job for **Depends on…** and **Delete**.
- **Cycles are refused.** A plan whose dependencies loop shows the loop, draws it in red, and can't run until you break it.
- **Run plan** starts one head per job in dependency order, grouped under the plan on the canvas. Running it again after adding jobs starts only the new ones.

**Jobs you drive yourself** ([Plan_Lanes_Plan.md](Plan_Lanes_Plan.md)):
- **Run as:** a job's popover has **Head** (Hydra drives it) or **Lane** (you drive it in a terminal). A lane job's card says "Draft job · Lane".
- **Starting:** a lane job opens as a lane as soon as the jobs it depends on are done, named after the job, with its brief as the goal.
  - The lane starts from their work.
  - Its first prompt names the plan and the job.
  - The full brief, with what the jobs before it did, is in `.hydra-job/brief.md` in its worktree, which is never committed.
- **Finishing:** commit in the lane, then press **Mark job done** on its tile (or on its card's ⋯ on the canvas).
  - Hydra runs the gates, or reuses a passing run on the same commit.
  - It asks for an optional note for the next jobs, then hands the lane's commit on: the jobs after it start from there.
  - **Merge** finishes the job too.
  - The lane's agent can call **`hydra_job_ready`**, which asks you; it never marks the job itself.
  - Until a job after it has started, you can press **Mark job done again**.
- **Heads after a lane job** wait until it's done. Heads after heads start as they did before.
- **On the canvas:**
  - A running plan shows its progress: "2 of 4 done · waiting for you in Build API".
  - Each job is its head card, its lane card, or a small node saying what it waits for, why it was skipped, or that it's done.
  - A lane card opens its lane. Its ⋯ has **Open lane**, **Mark job done**, **Cancel job** and **Diff**.
- **Failures:** when a head fails, or a lane is closed before its job is done, the jobs after it are skipped and the plan is **Incomplete**.
  - **Retry failed jobs** starts them again, with a new lane for a lane job.
  - **Cancel job…** (in a lane's ⋯, or a job's ⋯ on the canvas) ends one job.
- **+ Job** works on a running plan too. The new job stays a draft you can edit until you press **Run plan**.
- **Limits and restarts:**
  - A plan lane that continues in the other agent stays under its plan.
  - A head that hit its limit holds the jobs after it until it goes on.
  - After Hydra restarts, a plan's lanes show Exited under the plan and nothing starts by itself. A lane job that was ready shows **Start lane**.

### Lanes

Heads are Hydra's agents. **Lanes** are yours: each lane is a real `claude` or `codex` terminal, signed in with your own account, working in its own git worktree and branch ([Lanes_And_Planner_Plan.md](Lanes_And_Planner_Plan.md), section 1). The Agents tab has two views, **Canvas | Lanes**.

- **New lane** (in the Lanes view, the Hydra panel's **+**, or **Hydra: New Lane**):
  - Give it a name, pick Claude Code or Codex, and optionally a goal.
  - With a goal, the agent starts on it straight away, already told what the other lanes are doing.
  - The first run asks you to trust the new folder; that's the CLI's own prompt.
- **The grid:**
  - Fixed-size tiles, two or three to a row, scrolling for more.
  - Click a tile to type into it.
  - Each tile shows its branch, files changed, and warnings: **Conflicts with Lane 3 · src/cart.ts**, **Conflicts with main**, **3 behind main**, **Merges cleanly**.
- **Coordination:**
  - Hydra predicts conflicts between lanes, and with main, every 10 seconds using `git merge-tree`. It never touches a lane's files and makes no model calls.
  - A lane's agent can call **`hydra_lanes`** to see the other lanes' goals, files and conflicts, and it can start heads, which appear under that lane on the canvas.
  - Hydra only warns; it never blocks a lane.
- **Finishing a lane:**
  - **Merge** merges the lane into the branch your folder is on, after a confirmation that says whether it merges cleanly. It refuses, with the reason, if there's nothing to merge, uncommitted work (**⋯ → Commit…** first), the wrong branch checked out, or a conflict with main.
  - **⋯ → Update from main** brings main into the lane; conflicts are left for you, or the lane's agent, to resolve in the lane.
  - **⋯ → Open PR** pushes the branch and opens GitHub's compare page.
- **Close lane:**
  - A merged lane closes quietly.
  - Otherwise, choose **Keep branch** (uncommitted work is committed as "WIP") or **Delete everything**.
  - Hydra only ever removes its own lane worktrees, and removes any links inside first, so it never deletes through a junction.
- **Gates on Merge:** with `"lanes": "onMerge"` (the default), **Merge** runs this project's gates on the lane first.
  - If they pass, the confirmation says so.
  - If they fail, you choose between **Send to lane** (the default), **Merge anyway** or **Cancel**. **Send to lane** types the failures into the lane's input without pressing Enter.
  - **⋯ → Run gates** runs them at any time, and **⋯ → View evidence** shows the results.
- **Usage limits:** when the agent in a lane hits its limit, the tile shows it, with **Continue in Codex** (or Claude), **View handoff** and **Wait**, and a notification names the lane.
  - **Continue** restarts the same lane with the other agent, in the same worktree, with a handoff. Uncommitted work is untouched.
  - **⋯ → Switch to…** does the same whenever you like.
  - With `hydra.lanes.onLimit: "switch"`, the lane switches by itself after a 10-second countdown you can cancel.
- **Restarting Hydra** ends the lanes' terminal sessions but keeps their worktrees. **Resume** continues the conversation (`claude --continue`, `codex resume --last`); **Start fresh** begins a new one. If the CLI never began a conversation (it stopped at its own update or folder-trust prompt), Resume opens an empty one; use **Start fresh**.
- **On the canvas:** every open lane is a node, heads it started grow from it, and lanes that would conflict are joined by a red dashed line. Click a lane to jump to its terminal.

The **Hydra panel** (the Hydra icon in the activity bar) lists your lanes, running heads and plans, with **New lane**, **New plan** and **Open Agents view** at the top. A plan shows its progress ("Running · 2 of 4 done · 1 lane waiting"), and a plan lane names its plan.

In the Lanes view, running lanes come first. Exited lanes are compact rows with Resume, Start fresh, Merge and Close lane; **Show terminal** opens the full tile.

New to all this? **Hydra: Learn Heads, Lanes, Plans and Gates** opens a short walkthrough. It also opens by itself the first time you open the Agents view, and the empty Agents and Lanes views link to it.

## Packs

A **pack** bundles what one kind of work needs: **roles** for lanes, heads and plan jobs, **gates**, **MCP servers** and **skills** ([Packs_Plan.md](Packs_Plan.md)).

- **Which packs exist:**
  - Hydra ships **Coding** (Builder, UI builder and Reviewer roles, a `code-review` gate, and Playwright for the UI builder) and **Research** (Researcher and Fact-checker, and a `fact-check` gate).
  - Your own packs are folders in `~/.hydra/packs` (the `hydra.packs.folder` setting).
  - A project can carry packs in `.hydra/packs/<id>/`.
- **Turning one on:**
  - **Hydra Settings → Packs → Turn on** first shows everything the pack would run: each command, each server and the roles that use it, each role's instructions, and each skill's files.
  - The button at the end of that review writes `.hydra/packs.json`, which you can commit.
  - Nothing from a pack runs before that.
  - A pack that isn't from Hydra says so, and is pinned to the files you reviewed: if any file changes, it stops until you review it again.
- **A teammate's `packs.json`:** Hydra asks once per project ("This project uses the Coding pack…"). Until you allow it on your machine, its gates show as **not run**.
- **Roles:**
  - Pick one in **New lane**, in a plan job's popover, or with `role` on `hydra_start_head`. A lead's instructions list the active ones.
  - A role sets the agent's instructions, its skills and MCP servers, and, for heads, web access.
  - Claude lanes get it with `--append-system-prompt-file` and `--plugin-dir`; Codex gets developer instructions. Everything is passed per process, and your Claude Code and Codex settings are never changed.
  - A Reviewer or Fact-checker may finish without changing anything; its summary is the result.
- **Gates:**
  - A pack's gates join `gates.json`. Your own gate with the same id wins.
  - **Skip in this project** turns one off.
  - Chips say "From the Coding pack". Settings → Gates lists them under **From packs**.
- **Windows:** a server command such as `npx` runs through `cmd.exe`, as Claude Code's docs advise.

## Security

- **Local endpoint:** Hydra listens on `127.0.0.1` only, on a random port. Requests with a foreign `Host` or any `Origin` are refused, which blocks web pages. Oversized and flooding requests are refused too.
- **Tokens:** every caller has its own random token, and only its hash is kept. The token alone decides who is calling (a window's lead, or one head) and which actions it may use. A head can't use lead actions. Head tokens are revoked when the job ends.
- **No lead secret on disk.** The discovery file (port, pid, folders) contains no token. A lead's bridge asks Hydra for its token once, and Hydra first asks Windows which process opened the connection, then walks that process's parents (`src/core/leadVerification.ts`):
  - **Refused** if the chain passes through any process Hydra started for a head or a head's checks. A head, and anything it starts, can't act as the lead.
  - **Refused** if the chain doesn't reach this Hydra window. That covers a detached process trying to escape its head, and a CLI run outside Hydra; use the extensions or a terminal inside Hydra.
  - Windows reports the connection's owner, so a caller can't pretend to be another process. A parent created after its child (a reused PID) ends the chain.
  - The token then lives only in that bridge's memory.
  - Verified live: a head's check process asking for a lead token was refused with "it runs inside a Hydra head".
  - On other platforms this check isn't implemented yet, and lead connections are accepted.
- **Logging:** every action, and every accepted or refused lead connection, is logged to the Hydra output channel.

## Supported versions

Hydra runs Claude Code 2.1.x from 2.1.270 and Codex 0.154.x from 0.154.0 (`src/core/cliVersions.ts`). The first time Hydra sees a new binary it runs a short real self-check (`src/core/cliSelfCheck.ts`) and remembers the result for that exact binary.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| "Hydra isn't open for this folder" | No Hydra window has the chat's folder open | Open the folder in Hydra |
| "Hydra heads are not set up for this CLI" | The agent isn't connected | Connect it in Hydra Settings → Connectors |
| "Hydra refused this lead: it was not started from this Hydra window" | The CLI runs outside Hydra (for example Windows Terminal) | Use the Claude Code or Codex extension, or a terminal inside Hydra |
| A head "exited without finishing" | Its CLI failed to start or crashed | **Open log** on the dashboard |
| Claude reports failing SessionStart hooks | A plugin hook fails (for example claude-mem without Bun or its dependencies) | Press Connect on Claude again; it sets up Bun and claude-mem. Hydra records hook failures and carries on. |
