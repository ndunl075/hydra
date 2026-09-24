# Plan: chat in the official extensions, let Hydra run the helpers

Status: decisions made 2026-09-23 (see "Decisions"). Nothing here is built yet; don't start until Nico says so.
Replaces: the marker-line delegation pipeline (`HYDRA_DELEGATION_V1`) and, over time, Hydra's own chat panel as the main place you talk to an agent.

## The idea in plain words

- You chat with Claude in the **real Claude Code extension**, or with Codex in the **real Codex extension**, inside Hydra.
- Hydra adds a small set of **actions** (MCP tools) to those extensions: "start a helper", "wait for helpers", "check a helper", "reply to a helper", "cancel a helper".
- When Claude or Codex decides some work can be split up, it uses those actions. **Hydra's own code** then runs each helper in the background, in its own worktree, checks the result, and hands it back.
- Helpers report through actions too ("I'm done", "I'm stuck"). Hydra never reads meaning out of chat text, so there is no fragile marker line.
- Hydra stops being a chat app and becomes the part that makes helpers safe and reliable: worktrees, limits, checks, review and merge.

Why: most of the bugs so far came from rebuilding a chat UI that those extensions already do well. Delegation in Auto mode also never completes today (see "Where we are").

## Where we are (checked 2026-09-23)

- **Auto mode stalls.** A parent only wakes after each child has a result receipt ([src/extension.ts](../src/extension.ts) around line 712). Receipts only come from the `hydra.receiveDelegationResult` command, and nothing in `src/` or `webview/` calls it; only tests do.
- **The planner suffix and marker go on every turn, Solo included.** Solo replies in the probe still ended with `HYDRA_DELEGATION_V1:{…}`.
- **46 delegation modules, about 3,900 lines.** Six of them are imported only by tests: `delegationRolloutReview`, `autoDelegationBrief`, `autoDelegationStopRecovery`, `delegationWakeup`, `autoDelegationSchedule` and `autoDelegationRollout`.
- **Hydra can already hand a task to an official extension.** `handoffTask` in [src/core/handoff.ts](../src/core/handoff.ts) opens the task's worktree in a new window, and the task is marked `external` meanwhile. The extension IDs and open commands are in that file.

## Facts this plan depends on

These were checked on this machine with Claude Code CLI 2.1.270 (Hydra's pinned version) and Codex CLI 0.154.0.

| Fact | Evidence |
| --- | --- |
| Both extensions install from Open VSX | `anthropic/claude-code` 2.1.281 and `openai/chatgpt` 26.5908.31748 are listed, with per-platform builds |
| Claude can register a tool server from JSON, per project or per user | `claude mcp add-json [-s local\|user\|project] <name> <json>` |
| A Claude tool server can have its own long call timeout | The server config field `timeout` (ms) is a hard wall-clock limit per call. Progress notifications do not extend it |
| **Claude moves slow tool calls into the background** | Built-in text: "MCP tool … is still running after Ns. It was moved to the background as task … you'll receive a notification with the result when it completes. You can keep working." Related: `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND` |
| Claude can deny instead of asking | `--permission-mode dontAsk` denies any tool that isn't pre-allowed. It does not prompt, and it does not stop the run |
| Claude has hard caps | `--max-turns` and `--max-budget-usd` |
| Claude "channels" (a server pushing a message into a running chat) exist, but are gated | They need a first-party login, can be switched off by an org, and need an approved channel or `--dangerously-load-development-channels`, which shows a warning prompt |
| The Claude extension lets Hydra wrap its process | Setting `claudeCode.claudeProcessWrapper` (an executable path) |
| Codex takes tool servers globally or per trusted project | `[mcp_servers.<name>]` in `~/.codex/config.toml`, or a project `.codex/config.toml` for trusted repos. Keys include `command`, `args`, `env`, `url`, `tool_timeout_sec`, `startup_timeout_sec` and `default_tools_approval_mode` |
| The Codex extension runs its own bundled `app-server` | Seen in `openai.chatgpt/out/extension.js`. `codex queue` targets the shared daemon, so it probably can't reach the extension's chats |

## How it will work

```
 You ──chat──▶ Claude Code / Codex extension (the "lead")
                    │  calls Hydra actions (MCP, stdio)
                    ▼
            hydra-mcp bridge  (tiny process started by the lead's CLI)
                    │  authenticated local HTTP, 127.0.0.1
                    ▼
      Hydra extension host: Job service (the only writer of job state)
          │ creates worktree + task      │ runs checks          │ answers wait/get
          ▼                              ▼                      ▼
   helper = headless claude -p / codex app-server in its own worktree,
            with the same bridge (its own token) and child-only actions
```

### Pieces

1. **Job service.** Lives in Hydra's extension host, which is the only process that writes job state.
   - **Store:** one job store per workspace (`jobs.json` in workspace storage), written atomically (temp file, then rename) and checked against one table of allowed state changes.
   - **Tasks:** each job owns a normal Hydra task, so the existing worktree, capacity, scheduler, runner and review code keeps working.
   - **States:** `queued → starting → running → checking → done`. `running ⇄ blocked` covers a helper that asks a question and gets an answer. `checking → running` re-prompts after failed checks while attempts remain. Any non-final state can go to `cancelled` or `failed`. The final states are `done`, `failed` and `cancelled`.
2. **Local endpoint.** `POST /hydra/v1/call` on 127.0.0.1, random port, one port per Hydra window.
   - **Auth:** every call carries a token.
   - **Identity:** the token alone decides who is calling (the lead for this window, or one specific job) and which actions it may use. A caller never names its own identity.
3. **`hydra-mcp` bridge.** A small stdio MCP server that ships in Hydra's `dist/`. It is run by Hydra's own executable with `ELECTRON_RUN_AS_NODE=1`, so Node doesn't need to be installed.
   - **Lead:** the bridge finds its Hydra window from a discovery file in Hydra's global storage. The file holds port, token, pid and folder, and is keyed by workspace. The bridge matches the CLI's working folder against it.
   - **Helper:** Hydra passes the port and token directly in the environment. Helpers never use the discovery file.
   - **No Hydra window:** if no window owns the folder, the bridge lists no tools and explains why when called.
4. **Registration** with each extension. Hydra refreshes it on every start, because Hydra's executable path changes with updates.
   - **Scope: user-level, never per project** (decision 2). The connection is between Hydra and your Claude Code / Codex install, not a repo, so no file is written into any project.
   - **Claude:** run `claude mcp add-json -s user hydra '{"type":"stdio","command":"<Hydra.exe>","args":["<dist>/hydra-mcp.cjs"],"env":{"ELECTRON_RUN_AS_NODE":"1"},"timeout":3600000}'`. Then allow `mcp__hydra__*` in the user's `~/.claude/settings.json`, so the actions don't trigger approval prompts.
   - **Codex:** add an `[mcp_servers.hydra]` table to `~/.codex/config.toml` with the same command, `tool_timeout_sec = 3600` and `default_tools_approval_mode` set to approve.
   - **Onboarding:** connecting happens in onboarding as "Connect Claude Code and Codex to Hydra" (Phase 5), with a matching on/off switch in Settings. Hydra never edits these files silently.
5. **Lead actions:**
   - `hydra_start_helper(title, brief, write_scope[], provider?, model?, depends_on?, idempotency_key)` returns a job id. It refuses if the idempotency key was already used, so a retry can't create a duplicate.
   - `hydra_wait_for_helpers(job_ids[], max_wait_s?)` returns when all of them have finished, or when `max_wait_s` passes (default 1800), with the status so far.
   - `hydra_get_helper(job_id)` returns the summary, branch, commit, changed files and check results.
   - `hydra_reply_to_helper(job_id, message)` answers a blocked helper; Hydra delivers the message into it.
   - `hydra_cancel_helper(job_id)`.
   - `hydra_list_helpers()`.
6. **Helper actions:**
   - `hydra_done(summary)`: Hydra records the commit, enforces the write scope, runs checks, and sets the job to `done`, or re-prompts the helper with the failures.
   - `hydra_stuck(reason, question?)`: sets the job to `blocked`, and the lead sees it in its wait result.
   - `hydra_progress(note)`: optional status for the helper list.
7. **Helpers** use Hydra's existing headless runners, with these changes:
   - **Base:** branched from the lead folder's **current HEAD**, not an old base. If the lead's folder has uncommitted changes, `hydra_start_helper` warns and says which changes the helper won't see.
   - **Claude permissions:** `--permission-mode dontAsk` plus an allowed-tools list, so an unexpected request is denied and the helper carries on instead of being killed.
   - **Codex permissions:** `workspace-write` sandbox with approval `never`.
   - **Limits, enforced:** 30 minutes wall clock (the helper is killed and the job marked `failed`); for Claude also `--max-turns 60` and `--max-budget-usd 5`. All three can be set per job.
   - **No report:** a helper that exits without calling `hydra_done` or `hydra_stuck` gets one automatic nudge ("you stopped without reporting…"), then is marked `failed`.
   - **Stop all:** a "Stop all helpers" command kills every helper within 5 seconds.
8. **Waking the lead:**
   - **Claude:** `hydra_wait_for_helpers` just blocks. Claude moves it to the background, you keep chatting, and Claude is notified when it finishes. Phase 1 confirms whether that notification starts a new reply while the chat is idle inside the extension.
   - **Codex:** the wait call keeps the turn visibly working, up to `max_wait_s`. If it returns early, the lead calls it again.
   - **Channels** are a later opt-in, only if Phase 1 shows they are usable in the extension without the warning prompt.
9. **Hydra UI.** The Agents view becomes the helper dashboard: jobs, states, logs, check results, "Review changes" and "Stop all". Hydra's chat panel stays as a fallback until Phase 7.

## Phases

Each phase is one PR with one gate: `npm run check`, `npm run build`, `npm test`, plus `desktop:build` only when desktop files change. Docs change only after a disposable CI run passes. GitHub Actions minutes are limited, so run the gate locally first.

### Phase 0: hide Auto until this lands (decision 1)
**Sonnet, small.**
- Remove Auto from the Solo/Auto picker and default everyone to Solo. That includes anyone with `hydra.delegationMode: "auto"` saved (Nico's setting is `auto` today).
- Solo turns stop getting the planner suffix, which also stops the marker leaking into replies and saves tokens on every message.
- Don't patch the missing receipt step; the redesign replaces that chain.

Acceptance:
- A Solo turn's prompt has no planner suffix, and the picker offers no Auto.
- A saved `auto` setting behaves as Solo.

### Phase 1: spikes, go/no-go
**Opus. Nothing lands in `src/`.**

Use the isolated probe profile and the scratch repo, never Nico's repos. Record the answers in this file under "Spike results".
1. **Install and sign in:** install both extensions from Open VSX into Hydra, and confirm each can sign in and run a turn.
2. **Claude registration:** register a throwaway stdio server with `claude mcp add-json -s user`. Does the **extension** list its tools in any folder? Does a user-level allow rule remove the approval prompt?
3. **Codex registration:** same check for Codex with a global `[mcp_servers]` entry in `~/.codex/config.toml`.
4. **Claude background wake:** a tool that sleeps 90s is backgrounded in the Claude extension. When it finishes, does the idle chat start a reply on its own, or only on your next message? Also test with `timeout` set to 3,600,000 ms.
5. **Codex long call:** a tool that sleeps 10 minutes with `tool_timeout_sec = 3600`. Does the Codex extension keep waiting, and can you stop it?
6. **Bridge launch:** start `Hydra.exe` with `ELECTRON_RUN_AS_NODE=1` running a stdio server, from both CLIs.
7. **Unattended Claude helper:** `dontAsk` with an allowed-tools list. An unexpected tool is denied and the run continues.
8. **Channels:** in the extension, can a Hydra channel run without the warning prompt? If not, drop it.

Stop and report to Nico if any of these fail:
- 2 or 3 fails: neither extension can see Hydra's actions, so this plan changes shape.
- 4 and 5 both fail: long waits don't work in either extension.

### Phase 2: job store and allowed state changes
**Opus.**
- `src/core/jobs.ts`: types, the transition table, atomic persistence, idempotency keys, and cleanup of stale locks at start (an `in-progress` marker older than its owner pid is cleared).
- Reuse `Task` for each job's worktree and runner. Link through `job.taskId`, not through the old delegation fields.

Acceptance:
- Property-style tests: every transition not in the table is refused.
- A save that crashes midway leaves the old file readable.
- A repeated idempotency key returns the first job.

### Phase 3: local endpoint, tokens and bridge
**Opus: this is the security boundary.**
- HTTP endpoint on 127.0.0.1 only, random port, 32-byte random tokens.
- Discovery file readable only by the current user where the OS allows it, removed on deactivate.
- Calls are rate-capped and size-capped.
- `dist/hydra-mcp.cjs`: the stdio MCP server. It depends on `@modelcontextprotocol/sdk`, bundled by esbuild, and forwards each call to the endpoint.

Acceptance:
- A wrong or missing token is refused.
- A child token can't use lead actions.
- The bridge with no Hydra window lists nothing.
- The bridge picks the right window when two are open.

Known gap, to be written down rather than hidden: a helper runs as your user, so it could read the lead's discovery file and act as the lead. Mitigations:
- A cap on helpers per lead.
- Every action is logged.
- Later, deny reads of Hydra's storage folder in the helper sandbox.

### Phase 4: helper lifecycle
**Opus for the lifecycle, Sonnet for the limits once the lifecycle is in.**
- Runner changes from "Helpers" above: base on HEAD, `dontAsk` / sandbox, enforced limits, the done/stuck actions, one nudge on a silent exit, and "Stop all".
- **Checks:** reuse `runDelegatedVerificationCommand` ([src/core/delegationVerification.ts](../src/core/delegationVerification.ts)), configured in `.hydra/checks.json` (commands plus timeouts). No config means done with "no checks configured". Failed checks re-prompt the helper, up to 2 more attempts.
- **Write scope:** enforced on the diff when `hydra_done` is called. Remove the hard-coded default scope list.
- **No approvals (decision 3):** helpers never ask anyone for permission. Anything outside their allowed tools and sandbox is denied, and they keep going.
- **CLI versions (decision 5):** accept any Claude 2.1.x from 2.1.270 up, and any Codex 0.154.x from 0.154.0 up, instead of one exact version.
  - The first time Hydra sees a new binary (same path, size and times as the launch-probe cache), it runs a real self-check: start, initialize, read settings, about 2 seconds. It remembers the result for that binary.
  - A failed self-check refuses to start helpers and gives a clear message, instead of failing midway through a job.

Acceptance, using the fixture CLI:
- A helper that times out is failed.
- A helper that exits silently is nudged once, then failed.
- Failed checks re-prompt, and the second attempt passes.
- An out-of-scope diff is refused.

### Phase 5: "Connect Claude Code and Codex" in onboarding (decision 2)
**Sonnet, after a short research step.**
- **Research first:** Nico modelled Hydra's onboarding on Zepp's. Look at how Zepp's onboarding connects the agent tools, and copy that flow and wording where it fits. Record what you found here before building.
- **Onboarding:** the Providers step becomes "Connect Claude Code and Codex to Hydra". For each provider it shows whether the extension and CLI are installed and signed in, with one Connect button that registers Hydra at user level (Phase 1 results decide the exact mechanism).
- **Settings:** the same connection with a Connect/Disconnect switch and a "Connected / Not connected / Error" line per provider. It's re-checked on every start, because Hydra's executable path changes with updates.

Acceptance:
- Connect, then disconnect, leaves `~/.claude.json`, `~/.claude/settings.json` and `~/.codex/config.toml` byte-identical apart from Hydra's own entries.
- Nothing is written inside any project folder.

### Phase 6: lead actions and the helper dashboard
**Opus for `wait` and `reply`; Sonnet for the dashboard UI.**
- The lead actions from "How it will work".
- Agents view: the job list, live state, logs, check output, review diff, and Stop all.

Acceptance:
- End to end in the probe with the scratch repo: the lead in the Claude extension starts two helpers, waits, gets both results and merges them itself with git.
- The same with Codex.

### Phase 7: remove the old pipeline
**Sonnet, after Phase 6 has been used for real for a while.**
- Delete the planner suffix and marker ingestion, the orchestration journal, the receipt and wake chain, and the six test-only modules, together with their docs.
- Decide separately whether Hydra's chat panel stays.

Acceptance:
- `npm test` passes with the old tests removed.
- No reference to `HYDRA_DELEGATION_V1` is left.

### Phase 8: docs
**Sonnet.**
- Replace `docs/Adaptive_Delegation.md` and the `Auto_Delegation_*` docs with one `docs/Helpers.md` covering the actions, states, limits and security notes.

## Decisions (Nico, 2026-09-23)

1. **Auto: hide it** until the new helpers land. No patch to the old receipt chain (Phase 0).
2. **Connect Claude Code and Codex to Hydra at user level, everywhere, never per project.** Connecting is part of onboarding, modelled on Zepp's onboarding (Phase 5). "The connection" means Hydra adding itself as a tool server in Claude's and Codex's own user settings, so any Claude or Codex session on this computer can use Hydra's helper actions while Hydra is open.
3. **Helpers never ask for permission.** They run inside their own worktree and sandbox with an allowed-tools list, and are capped on time, turns and cost (Phase 4).
4. **The lead merges helper branches itself with git.** No Hydra merge action in v1; the dashboard still shows each helper's diff for review.
5. **Allow a version range with a self-check:** Claude 2.1.x from 2.1.270, Codex 0.154.x from 0.154.0, checked once per binary (Phase 4).
6. **Keep Hydra's own chat panel as a fallback.** Revisit after Phase 7.

## Model calls

| Phase | Model | Why |
| --- | --- | --- |
| 0 | Sonnet | Small and bounded |
| 1 | Opus | Judgment on unclear results; decides go/no-go |
| 2 | Opus | Core state model that everything depends on |
| 3 | Opus | Security boundary |
| 4 | Opus, then Sonnet | Process lifecycle edge cases first; limits and UI wiring after |
| 5 | Sonnet | Zepp research, the onboarding step and config writing, with clear acceptance checks |
| 6 | Opus (`wait`/`reply`), Sonnet (UI) | Blocking calls and delivery need care; the dashboard is routine |
| 7–8 | Sonnet | Deletion and docs with a clear finish line |

## Rules for whoever builds this

- Don't add a `patches/` directory. Don't change `desktop/upstream.json` or the pinned commit.
- Stop and report to Nico if the upstream shape guard fails, `desktop:verify` starts failing, or editor startup breaks.
- Don't wipe `node_modules`. Don't run `claude update` on the PATH `claude.exe`.
- Test with the isolated probe profile and a scratch repo, never Nico's `orven` repo or his real Hydra profile.
- For extension-only changes, copy `dist/` into `.desktop/VSCode-win32-x64/resources/app/extensions/hydra-agent-manager/dist` instead of a full `desktop:build`. That saves about 20 minutes and a lot of battery.
- Merging needs Nico's explicit OK for each PR.

## Not in this plan

- Keeping one Claude or Codex process running per chat. The official extensions already do this for the lead. For helpers it's an optimization for later.
- Pasting into terminals, mailboxes agents must check themselves, or anything that reads meaning out of chat text. These were the weak points in the Ninebrains comparison.

## Spike results

(Filled in by Phase 1.)
