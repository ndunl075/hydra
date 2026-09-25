# Gates, and the usage-limit offer in lanes

Status: **built** (2026-09-25). See "As built" at the end.

## Goal

1. **Gates:** no agent grades its own work. Before a head's work is accepted, or when you merge a lane, a second pass has to prove it:
   - the project's commands (tests and so on);
   - an independent reviewer;
   - optionally, screenshots of the UI.

   A failed gate sends its evidence back to the head, up to the attempt limit.
2. **Lane-aware limit offer:** when the agent in a lane hits its usage limit, the offer appears on that lane's tile. **Continue in Codex** (or Claude) restarts the same lane with the other agent, in the same worktree, with a handoff.

## What exists today

- **Head checks.** When a head calls `hydra_done`, Hydra first checks its write scope. It then runs `.hydra/checks.json` from the lead's folder in the head's worktree, and sends failures back to the head with the output tail. After `maxAttempts` the head is failed (`HelperService.accept` / `checkFailed`, `runChecks`, `checkCommand.ts`).
- **The usage-limit offer (#201).**
  - Claude's StopFailure hook writes a limit event with the session's `cwd`.
  - Codex's account rate-limit snapshot emits a `chat` event with no cwd.
  - `LimitWatcher` gives an event to the window whose workspace folders contain the cwd, or to any window after a grace period.
  - `registerLimitOffer` shows **Continue in <Other>** (restarting a head with `continueWith`, or copying a handoff and opening the other chat), **View handoff** and **Wait**.

## 1. Gates

### Configuration: `.hydra/gates.json` (read from the lead's folder, never a worktree)

```json
{
  "maxAttempts": 3,
  "lanes": "onMerge",
  "gates": [
    { "id": "unit", "type": "command", "command": ["npm", "test"], "timeoutSeconds": 600, "required": true },
    { "id": "ui", "type": "screenshots", "start": ["npm", "run", "dev", "--", "--port", "{port}"], "url": "http://localhost:{port}/", "widths": [390, 768, 1280], "readyTimeoutSeconds": 90, "required": false },
    { "id": "review", "type": "review", "reviewer": "other", "focus": "", "required": true }
  ]
}
```

- **Compatibility:** without `gates.json`, an existing `.hydra/checks.json` still works, with its checks read as `command` gates. With neither file, a head is accepted after the scope check, as today.
- **`lanes`:** `"onMerge"` (the default) runs the gates when you press Merge on a lane; `"off"` doesn't.
- **Order:** command gates run first (cheap), then screenshots, then the review. The reviewer sees the earlier results and the screenshots.
- **`required: false`:** the gate is reported but never blocks.
- **Validation:** ids `[a-z0-9-]{1,24}`, unique; commands are arrays of strings; widths 240–3840 (at most 4); `url` is http or https on localhost or 127.0.0.1; at most 12 gates in all.

### Command gate

Today's check, unchanged: run in the head's worktree, with its timeout, the output tail kept, and the log saved.

### Review gate

- **Who reviews:**
  - `reviewer: "other"` (the default) uses the other agent: Codex reviews a Claude head, and the reverse.
  - If the other agent isn't installed, or is limited, Hydra uses a fresh read-only session of the same one, and says so.
  - `"same"`, `"claude"` and `"codex"` force a choice.
- **How it runs:** read-only in the head's worktree.
  - Claude: `claude -p --output-format json --permission-mode plan`.
  - Codex: `codex exec --json --sandbox read-only`.
  - Launch goes through `processLaunch`; timeout 5 minutes.
- **Prompt:**
  - the head's brief and write scope;
  - `git diff <base>..HEAD`, capped at 60 KB with a note when cut;
  - the earlier gates' results;
  - the screenshot file paths (Claude reads images by path; Codex gets `-i <png>`);
  - the project's `focus` text;
  - "reply with JSON only".
- **Output:** `{ "verdict": "pass" | "fail", "summary": "…", "findings": [{ "file": "…", "line": 12, "severity": "blocker" | "major" | "minor", "note": "…" }] }`.
  - The parser takes the first JSON object and tolerates code fences, as the planner's does.
  - The gate fails only for `fail` with at least one blocker or major finding. Minor findings are reported but don't fail the gate.
- **Couldn't run** (the tool is missing, it's limited, it timed out, or it returned unparseable output): the gate is reported as **not run** with the reason. It doesn't fail the head, since a tooling problem isn't the head's fault. The lead and the tile both show it.

### Screenshots gate

- **Port:** Hydra picks a free local port and substitutes it for `{port}` in `start` and `url`. It also sets `PORT`, so parallel heads never collide.
- **Starting the app:** the start command runs in the head's worktree as a tracked process tree, just as checks do. Hydra polls `url` until it answers with HTTP < 400, up to `readyTimeoutSeconds`.
- **Capture:**
  - A headless browser, driven over the DevTools protocol, visits the URL at each width: Edge on Windows, otherwise Chrome or Chromium from the usual paths.
  - The height is the full page, capped at 4000 px.
  - PNGs go under the head's log directory.
- **Fails** if:
  - the page never gets ready;
  - it returns HTTP ≥ 400;
  - it throws uncaught errors or logs `console.error`;
  - the body renders empty (no text and no images) at any width.
- **Afterwards:** the dev server's tree is always killed, the browser profile is a temporary folder that gets deleted, and no browser is left running.
- **Evidence:** the PNGs, plus the console and page errors.

### Heads

- **Where gates run:** in `HelperService.accept`, gates replace `runChecks`. The scope check comes first, then the gates in order, as above.
- **Results:** `JobCheckResult` gains `kind` (`command | screenshots | review`), `state` (`passed | failed | notRun`), `evidence` (file paths) and `findings`.
- **On failure:** the head's message lists what failed, with the findings or errors and the screenshot paths, and uses the same attempt counting. `maxAttempts` comes from `gates.json`, or else from the current default.
- **`hydra_get_head`** returns the gate results, so the lead sees them.

### Lanes

- **On Merge** (with `lanes: "onMerge"`):
  1. The lane must be committed; the existing refusal covers that.
  2. The gates run against the lane's worktree, with the diff from merge-base(target, lane).
  3. The tile shows progress: "Gates: unit ✓ · review …".
- **If a gate fails**, a modal lists the failures and offers:
  - **Merge anyway**;
  - **Send to lane**, which writes a prompt summarizing the findings into the lane's terminal without pressing Enter;
  - **Cancel**.
- **⋯ → Run gates** runs them at any time without merging.
- **Results** are kept on the lane (the last run only) and shown as chips.

### Seeing results

- **Head cards and lane tiles:** gate chips (**✓ unit · ✓ review · ✗ ui**), with text as well as colour.
- **View evidence**, on the head menu and the lane menu, opens a read-only Markdown document: each gate, its state, the output tail, findings with file:line links, and the screenshots as images.
- **Hydra Settings → Gates** (a new page in the settings shell):
  - lists this project's gates;
  - adds or edits command, review and screenshot gates in a form;
  - sets `maxAttempts` and the lanes policy;
  - writes `.hydra/gates.json` in the workspace root (a normal file that you can commit), or converts `checks.json` when you save.

## 2. Usage-limit offer in lanes

- **Tagging:**
  - The Claude hook script (`hydra-limit-hook`) records `HYDRA_LANE_ID` from its own environment, which it inherits from the lane's session, into the event.
  - `LimitEvent` gains `source: 'lane'` and `laneId`.
- **Claiming:** the owning window claims at once any event whose `laneId` is one of its lanes, or whose cwd is inside one of its open lane worktrees. The watcher's owned folders include the lane worktrees.
- **Codex:** when the Codex account becomes limited (the existing snapshot event), each running Codex lane in the window gets a lane event. Chats keep the current behaviour.
- **The offer on the tile:**
  - A banner: "Claude Code hit its usage limit (resets 3:40 PM)." with **Continue in Codex**, **View handoff** and **Wait**.
  - The notification names the lane.
  - If the other agent is limited too, only Wait (the existing `otherStillLimited` logic).
- **Continue in <Other>:**
  1. Build the handoff with the existing builder: the transcript for Claude, git state, files touched.
  2. End the lane's session.
  3. Set `lane.provider` to the other agent and append `{ from, to, at, reason: 'limit' }` to `lane.switches`.
  4. Launch the other CLI in the **same worktree and branch**, with the lane preamble plus the handoff as its first prompt.

  Uncommitted work is untouched. The tile shows the new provider and "Continued from Claude Code (limit)".
- **⋯ → Switch to <Other>** does the same by hand at any time, for example to go back once the limit resets.
- **Setting `hydra.lanes.onLimit`:** `"ask"` (the default) or `"switch"`. With `"switch"`, the tile shows "Switching to Codex in 10 s" with **Cancel**, then switches.

## 3. What a head starts from

Two gaps found on 2026-09-25, fixed in the same place (`HelperService.startHelper` / `launch`).

- **Dependent heads build on what they waited for.** Today a head with `depends_on` waits, then still branches from the commit its lead was on when the head was created, and it never hears what its dependencies did. Instead:
  - **One dependency:** the dependent's worktree starts from that head's result commit (`result.commit`).
  - **Several:** Hydra starts from the first dependency's result commit and merges the others in its new worktree (`git merge --no-edit`, recorded as one commit by Hydra). If they conflict, the dependent fails before it starts: "The heads it depends on conflict in <files>; merge them first." The lead sees this like any other failure.
  - **The brief** gains "What the heads you depend on did:", with each dependency's title, summary, branch and changed files (capped at 4 KB).
  - **`base_commit`** in `hydra_get_head` shows the commit the dependent really started from, so the lead merges it knowing it already contains its dependencies.
- **Heads started from a lane branch from the lane.** A head started by a lane's agent (the caller has a lane) takes the lane's current `HEAD` as its base, not the main checkout's. As for any lead, uncommitted lane work isn't included, so the lane's agent is told to commit first. Checks and gates still come from the main checkout's `.hydra/`. The lane's agent merges the head's branch into the lane.
- **Tests:**
  - A dependent starts from its dependency's commit, and sees its file.
  - Two dependencies are merged in; conflicting ones fail it with the files named.
  - The dependency summaries appear in the brief.
  - A head started from a lane has the lane's commit as its base.

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | Gates core: `gates.json` schema, loader and compatibility; command, review and screenshot gates (`src/core/gates/`); result model; wiring into `HelperService.accept`; `hydra_get_head` output. Plus section 3: what a head starts from (dependency commits and summaries, lane base). Tests with fake runners, a fake browser and real temp repos. | **Opus**: process control, the browser over CDP, the acceptance path |
| 2 | Lane-aware limit offer: hook lane id, event source, watcher claiming, the Codex lane fan-out, the tile banner and switch, `lanes.onLimit`. In parallel with 1. | **Sonnet** |
| 3 | Gates UI: gate chips on heads and lanes, View evidence, lane Merge and Run gates flow with Send to lane, the Settings → Gates page. After 1. | **Sonnet** |
| 4 | Live verification in an isolated window (dev extension path), docs (Heads.md, README, this plan's "As built"), gate, PR, merge, light refresh. | **Opus** |

## Acceptance

- **Unit tests:**
  - `gates.json` validation, and compatibility with `checks.json`;
  - gate order, and `required: false`;
  - review prompt building (the diff cap), the output parser (fenced, noisy, invalid), and the verdict rule (a minor-only fail passes); "not run" doesn't fail the head;
  - screenshots: `{port}` substitution, ready polling, fail rules (blank, HTTP ≥ 400, console error) using a fake browser, and cleanup kills the server tree;
  - head accept: gates in order, a failure message with findings, attempts counted;
  - lanes: `onMerge` runs gates, and a failure offers Merge anyway;
  - limit: the hook records the lane id; the watcher claims lane events; Codex fans out to Codex lanes; a switch relaunches the same worktree with the other CLI and the handoff, and records the switch.
- **Smoke:**
  - a head with a failing command gate is sent back, then accepted;
  - the Settings → Gates page is contributed;
  - `lanes.onLimit` is a contributed setting.
- **Live (probe, real CLIs):**
  1. A head with `npm test` and a review gate: the reviewer (the other agent) runs and its findings show under View evidence.
  2. The screenshot gate on the lane-demo repo with a tiny static server: 3 PNGs, and a deliberately broken page fails.
  3. Merge on a lane runs the gates; a failure shows Merge anyway and Send to lane.
  4. A simulated Claude limit in a lane (`hydra.debug.simulateLimit` extended to take a lane) shows the tile banner; Continue in Codex relaunches the lane with Codex in the same worktree.

**Done** when the gate passes (check, build, tests, smoke), the live checks pass, the PR is merged with CI green, the installed app is refreshed, and Nico has the summary.

## As built

**Where it lives**
- **Gates:** `src/core/gates/` (`config.ts`, `index.ts`, `command.ts`, `review.ts`, `browser.ts`, `screenshots.ts`, `types.ts`).
- **Head start:** `src/core/headStart.ts`.
- **Evidence:** `src/core/evidence.ts`.
- **Settings page:** `src/settings/pages/gates*.ts`.
- **Lane gates, and the limit offer:** `extensionLanes.ts` and `laneService.ts`.
- **The hook's lane tag:** `hydraLimitHook.ts` and `limitDetection.ts`.

**Changes from the plan**
- **The review prompt goes on stdin,** because a 60 KB diff doesn't fit a Windows command line. Codex runs `exec --json [-i png]… --sandbox read-only -`.
- **Once a required gate fails, the later ones are skipped** ("Skipped: unit failed first."), so you don't pay for a review of work that's going back anyway.
- **Command names** such as `npm` are looked up on PATH/PATHEXT on Windows.
- **A browser that can't start** marks the screenshots gate **not run**, like an unavailable reviewer.
- **Several dependencies are combined** with `git merge-tree` plus `commit-tree`, so a conflict fails the dependent before any worktree exists.
- **An unreadable `gates.json`** never costs the head an attempt. The head is told to ask with `hydra_stuck`.
- **View evidence writes a real `.md` file** next to the run's evidence, with relative links and `#L` line anchors. The Markdown preview refuses `file:` links, so a virtual document showed them as raw text.
- **Lane merges and limits:**
  - A failed lane merge defaults to **Send to lane**, never **Merge anyway**. If the lane's session has ended, the findings go on the clipboard with a **Resume** offer.
  - A lane's usage limit also shows a notification naming the lane.
  - A limit event from the agent a lane has already left is ignored.
- **Removing a lane worktree** copes with a close that races another close.

**Verified live** (2026-09-25):
- **Review:** the real `claude -p … --permission-mode plan` and `codex exec --json … -` reviews both returned the JSON verdict and caught a planted bug.
- **A head's gates:** a Claude head started from a lane passed command, screenshots and a Codex review, with chips on the canvas. The evidence document showed the real screenshots and the review.
- **A lane merge:** with a failing `unit` gate it offered Send to lane. Send to lane typed the failures without pressing Enter.
- **Settings → Gates** listed the project's gates.
- **The limit offer:**
  - The real Claude hook, run with a lane's id, showed the tile banner and the notification.
  - Continue in Codex relaunched the lane with Codex in the same worktree, with an uncommitted file intact.
  - Wait dismissed the banner.
  - `onLimit: "switch"` counted down and switched.

**Not done, or later**
- **The screenshots gate** was verified with a static page. A Vite or Next dev server through `npm run dev` wasn't tried live.
- **Codex limit fan-out** (one account-level event reaching every Codex lane) is covered by unit tests only.
- **Packs and Freebuff.**
