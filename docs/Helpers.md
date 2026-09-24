# Hydra helpers

You chat with Claude in the Claude Code extension, or with Codex in the Codex extension. When a task has independent pieces, the agent can hand them to **Hydra helpers**: separate agents that Hydra runs in their own git worktrees, checks, and hands back. The agent you're chatting with is the **lead**, and it merges the helpers' work with git.

This replaces the old Auto delegation, which read a `HYDRA_DELEGATION_V1` line out of chat text. How it was designed and verified is in [Official_Extensions_Plan.md](Official_Extensions_Plan.md).

## Connecting Claude Code and Codex

Connect in onboarding (step 03, Providers) or in **Hydra Settings → Hydra helpers**. Each agent has one row: its install state, a Connect or Disconnect button, and Sign in. Claude Code and Codex keep their own sign-in and billing.

Connecting adds Hydra as a user-level tool server named `hydra`. That's per user, never per project; nothing is written inside a repository.

| Agent | What Hydra writes | Undone by Disconnect |
| --- | --- | --- |
| Claude Code | `claude mcp add-json -s user hydra …` (stored by Claude in `~/.claude.json`), and an `"mcp__hydra"` allow rule in `~/.claude/settings.json` | Yes. `settings.json` is restored byte for byte |
| Codex | A marked `[mcp_servers.hydra]` block at the end of `~/.codex/config.toml` | Yes. The file is restored byte for byte |

- **What the tool server is:** `dist/hydra-mcp.cjs`, run by Hydra's own executable with `ELECTRON_RUN_AS_NODE=1`, so Node doesn't need to be installed.
- **Hydra updates:** if an update moves Hydra's executable, Hydra refreshes an existing connection on its next start. It never connects anything you didn't.
- **When helpers are available:** only while a Hydra window has that folder open. Otherwise the actions answer "Hydra isn't open for this folder".

## What the agents can do

**The lead:**

| Action | What it does |
| --- | --- |
| `hydra_start_helper` | Start a helper, given `title`, `brief`, `write_scope` (repository paths it may change), `idempotency_key`, and optionally `provider`, `model`, `depends_on` and `limits`. Returns a job id at once. A repeated key returns the same job instead of starting another. |
| `hydra_wait_for_helpers` | Wait until the helpers finish or ask a question, then return their results. It keeps the lead's turn open; Claude and Codex both resume by themselves when it returns. `max_wait_s` defaults to 1800. |
| `hydra_get_helper` / `hydra_list_helpers` | State, summary, branch, commit, changed files and check results. |
| `hydra_reply_to_helper` | Answer a helper that asked a question. |
| `hydra_cancel_helper` | Stop a helper. Its branch is kept. |

**A helper:**

| Action | What it does |
| --- | --- |
| `hydra_done` | Report the work finished. Hydra commits anything left uncommitted, refuses changes outside the write scope, and runs the checks, all inside the call. If something fails, the helper is told what to fix, with up to 3 attempts. |
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
- **Queueing:** helpers wait in a queue up to `hydra.maxConcurrentHelpers` (default 3). A helper whose dependency failed or was cancelled fails too.
- **Silent stops:** a helper that stops without calling `hydra_done` or `hydra_stuck` is nudged once, then failed. A helper process that exits is failed.
- **After a restart:** helpers that were running are failed with the reason, because no helper process survives a restart.

## Limits and permissions

- **Starting point:** each helper gets a new worktree and branch from the lead folder's **current HEAD**. If that folder has uncommitted changes, the lead is warned that the helper won't see them.
- **Limits** (defaults; the lead can change them per job): 30 minutes of work (time spent waiting for an answer doesn't count), 60 turns and 5 USD. The turn and cost caps apply to Claude only.
- **No permission prompts:** helpers never ask anyone.
  - **Claude:** `--permission-mode dontAsk` with an allowed-tools list (file tools, Bash/PowerShell, and Hydra's helper actions; no web tools). Anything else is denied and the helper carries on. Your user-level allow rules in `~/.claude/settings.json` also apply to helpers.
  - **Codex:** `codex exec` with the `workspace-write` sandbox and approval `never`. On Windows that sandbox blocks writes to a worktree's `.git` metadata, which is why Hydra does the commit.
- **Stop everything:** **Hydra: Stop All Helpers** in the command palette, or **Stop all** on the dashboard.

## Checks

Checks come from the **lead's** folder, never from a helper's worktree, so a helper can't edit them away. Put them in `.hydra/checks.json`:

```json
{ "checks": [ { "id": "unit", "command": ["npm", "test"], "timeoutSeconds": 600, "required": true } ] }
```

With no checks file, a helper is accepted after the scope check.

## The dashboard

The Agents view shows a **Helpers** section for each helper:
- its state ("Needs an answer" while it waits on the lead), progress or question, summary, number of changed files, check results and commit;
- **Review changes**, which opens the diff and names the branch to merge;
- **Open log**, the helper's raw output with its token removed;
- **Cancel**, and **Stop all**.

## Security

- **Local endpoint:** Hydra listens on `127.0.0.1` only, on a random port. Requests with a foreign `Host` or any `Origin` are refused, which blocks web pages. Oversized and flooding requests are refused too.
- **Tokens:** every caller has its own random token, and only its hash is kept. The token alone decides who is calling (a window's lead, or one helper) and which actions it may use. A helper can't use lead actions. Helper tokens are revoked when the job ends.
- **Discovery file:** the lead's bridge finds its window through a small file in Hydra's global storage, readable only by your user where Windows allows.
- **Logging:** every action is logged to the Hydra output channel.
- **Known gap:** a helper runs as your user, so it could read that discovery file and act as the lead. The mitigations are the cap on unfinished helpers per window (16), per-action logging, and helpers' lack of web tools.

## Supported versions

Hydra runs Claude Code 2.1.x from 2.1.270 and Codex 0.154.x from 0.154.0 (`src/core/cliVersions.ts`). The first time Hydra sees a new binary it runs a short real self-check (`src/core/cliSelfCheck.ts`) and remembers the result for that exact binary.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| "Hydra isn't open for this folder" | No Hydra window has the chat's folder open | Open the folder in Hydra |
| "Hydra helpers are not set up for this CLI" | The agent isn't connected | Connect it in Settings → Hydra helpers |
| A helper "exited without finishing" | Its CLI failed to start or crashed | **Open log** on the dashboard |
| Claude reports failing SessionStart hooks | A plugin hook (for example claude-mem needing Bun) fails | Install what the hook needs, or disable the plugin. Hydra only records the failure. |
