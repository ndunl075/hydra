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

## Checks

Checks come from the **lead's** folder, never from a head's worktree, so a head can't edit them away. Put them in `.hydra/checks.json`:

```json
{ "checks": [ { "id": "unit", "command": ["npm", "test"], "timeoutSeconds": 600, "required": true } ] }
```

With no checks file, a head is accepted after the scope check.

## The Agents view

Open it with **Ctrl+Alt+A**, or **Agents** in the status bar. It's a live canvas of your heads ([Agents_View_Plan.md](Agents_View_Plan.md)):

- **Blank until a chat starts heads.** Each head grows out of the chat that started it: the **lead**, labelled with its provider, and a name if the chat gave one (`lead_label`).
- **What each head is doing:** state (Queued, Working, Needs an answer, Checking, Done, Failed), its latest progress note or question, branch and elapsed time. When it finishes: checks passed and files changed.
- **How heads connect:** a flowing edge from the chat while a head works, and amber dependency edges (`depends_on`) between heads. A dependent sits to the right of what it waits on.
- **Heads leave when they're merged.** Hydra notices within seconds when a head's commit is in your folder's HEAD, and the head collapses back into its chat. A finished head that isn't merged stays two minutes, then moves to the **Finished** tray.
- **Actions** (click the ⋯ on a head, right-click, or Shift+F10): **Open diff**, **Open log** (token removed), **Answer question…** for a head waiting on the lead, and **Cancel head**. **Stop all heads** is in the toolbar.
- **Heads list** on the side: Running, or All today. Selecting a head centres it on the canvas; Enter opens its diff.
- **Pause motion**, zoom (Ctrl+wheel) and drag to pan. Reduced-motion and high-contrast settings are respected.

The view never starts work itself; everything on it comes from what your Claude Code and Codex chats do.

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
