# Send plan jobs to lanes

Status: **built** (2026-09-25). See "As built" at the end.

## Goal

Today every plan job runs as a head. This plan adds a choice per job:

| Run as | Who drives | Done means |
| --- | --- | --- |
| **Head** (as today) | Hydra: the head works alone and reports with `hydra_done` | Its gates pass |
| **Lane** (new) | You: the job opens a lane with its brief as the goal | You merge the lane, or press **Mark job done** |

A plan can mix both. Jobs still start in dependency order. A job always starts from the work of the jobs it depends on, whether heads or lanes did that work.

**Out of scope:**
- lanes started by a lead's `hydra_start_head`;
- re-running a lane job that's done;
- adding jobs to a running plan from the canvas (open question 5).

## What exists today

- **Running a plan** (`runPlanById` in `extension.ts`, `runPlan` in `plans.ts`): every unstarted job becomes a head at once, in topological order, through `HelperService.handle(…, 'hydra_start_head', …)`. Each head gets:
  - the lead `plan-<id>`, with `lead_label` "Plan · <title>";
  - the idempotency key `plan-<id>-<key>`;
  - `depends_on` mapped to the head ids already recorded.

  `HelperService.dispatchQueued` keeps dependents queued until their dependencies are done, and fails them if one fails.
- **Plan state:** `finishDonePlans` makes a running plan done once `allJobsDone`. A failed head leaves its plan running for good, because `planTransitions.running` only allows `done`.
- **Where a head starts** (`headStart.ts`): `dependencyBase` starts a dependent from its dependencies' result commits, merged with `git merge-tree` when there are several. `dependencyBrief` tells it what they did. Both only see heads: `dependencyResults` reads the job store, and `parseJobInput` accepts only head ids in `depends_on`.
- **Lanes:**
  - `LaneService.create` always branches from the main checkout's HEAD (`createWorktree(…, undefined, layout)`).
  - A lane has no link to a plan.
  - `mergeLane` returns the target's merge commit, not the lane's own HEAD.
- **Canvas** (`buildCanvas`): only plans being drafted (planning, draft, failed) get a plan node. A running plan's heads group under the `plan-<id>` lead, as a chat's heads do. A running plan has no node of its own.
- **Planner:** `parsePlanJobDraft` keeps only the fields it knows.

## 1. The job model

```ts
export type PlanJobRunAs = 'head' | 'lane';
export interface PlanJob {
  key: string; title: string; brief: string; provider?: Provider;
  dependsOn: string[]; writeScope?: string[];
  /** Who drives it. Missing means 'head', as in every plan saved before this change. */
  runAs?: PlanJobRunAs;
  /** runAs 'head': the head's job id, once started. */
  jobId?: string;
  /** runAs 'lane': the lane's id, once started. */
  laneId?: string;
  /** runAs 'lane': the work it handed on. */
  result?: { commit: string; via: 'merged' | 'marked'; at: string; note?: string; changedFiles: string[] };
  /** A job that won't finish. */
  outcome?: { state: 'failed' | 'cancelled' | 'skipped'; reason: string; at: string };
  /** How many times Retry failed jobs has restarted it. */
  attempt?: number;
}
```

**Validation** (`validatePlanJobs`):
- `runAs` is missing, `'head'` or `'lane'`.
- `jobId` appears only on head jobs; `laneId` and `result` only on lane jobs.
- **A lane job's brief is at most 2000 characters**, because it becomes the lane's goal. The constant is `planLaneBriefMax`, equal to `laneGoalMax`, and a test keeps them equal. The popover counts down, and a planned job with a longer brief can't switch to Lane until it's shortened.
- `result.commit` is a full SHA, `changedFiles` has at most 300 entries, and `note` at most 2000 characters.
- A job never has both `result` and `outcome`.
- `outcome.reason` is at most 500 characters.

**Storage:** unchanged, in `globalStorage/…/plans/plans.json`. Old plans load as they are: no `runAs` means head.

**Editing:**
- `planSaveJob` gains `runAs`.
- A job's `runAs` can't change once it has started.
- A lane job keeps its `writeScope`, but only as advice: it goes into the lane's first prompt, and nothing is refused.

## 2. Running a plan

### The plan runner

A new module, `src/core/planRunner.ts`, decides and acts. Its decisions are pure (`planSteps`). It acts through injected starters, so tests use fakes.

- **`planSteps(plan, look)`** (pure) gives each job's status and what to do next. `look` answers "What state is head X in, with what result?" and "What state is lane Y in?"
- **`PlanRunner.advance(planId)`** applies the steps on one queue per plan, so two events can't start the same job twice.
- **It advances after:**
  - Run plan;
  - every heads change (`headsChanged`, which calls `finishDonePlans` today);
  - every lanes change (`laneFoldersChanged`);
  - Mark job done and Cancel job.

  These are debounced by 200 ms.

### Job status

| Status | Head job | Lane job |
| --- | --- | --- |
| **waiting** | Not started: a lane job it depends on isn't done, or a head job it depends on hasn't started | Not started: something it depends on isn't done |
| **active** | Its head is queued, starting, running, blocked or checking | Its lane is open (running or exited), with no result recorded |
| **held** | Its head failed on a usage limit (`limitHit`); **Continue in** can bring it back | Never: a lane at its limit stays open |
| **done** | Its head is done | Its `result` is recorded |
| **failed** | Its head failed | Its lane closed without a result, or it couldn't start |
| **cancelled** | Its head was cancelled | You cancelled the job |
| **skipped** | A job it depends on failed, was cancelled or was skipped | Same |

### When a job starts

- **A head job** starts when every **lane** job it depends on is done and every **head** job it depends on has started, so that head's id can go in `depends_on`. `HelperService` then holds it until those heads are done. The runner walks jobs in topological order within one pass, so a chain of heads behind a lane is created in one go once the lane is done. A plan with only head jobs behaves exactly as today: every head is created at Run.
- **A lane job** starts when **every** job it depends on is done.
- **A job never starts** after a dependency fails, is cancelled or is skipped. It becomes skipped: "Schema did not finish." If a dependency is **held**, the job waits instead.

### Starting a lane job

1. **Dependencies:** their results become `DependencyResult`s, for heads and lanes alike. `DependencyResult` gains `kind: 'head' | 'lane'`. A lane's summary is its Mark job done note, or else the subjects of its commits (`git log --format=%s base..result`, at most 10).
2. **Starting commit:**
   - no dependencies: the main checkout's HEAD, as for any lane;
   - one: its result commit;
   - several: one commit that merges them, made by `dependencyBase`. A conflict fails the job: "The jobs it depends on conflict in src/cart.ts; merge them first."
3. **The lane:** `LanesController.startPlanLane` calls `LaneService.create(input, { baseCommit, plan })` with:
   - **name:** the job title made lane-safe by `laneNameFromTitle`: characters `laneNamePattern` doesn't allow become spaces, the result is cut to 40 characters, and it falls back to "Plan job" if nothing is left;
   - **goal:** the brief;
   - **provider:** the job's, else `hydra.defaultProvider`. With packs, the role's provider comes in between;
   - **base:** through `createWorktree`'s existing `startingCommit` parameter;
   - **target:** the branch the main checkout is on, as for any lane.
4. **Recording:** the plan records `laneId`. Hydra shows "Plan Checkout started lane Build API" with **Show lane**. It doesn't switch views by itself.

**The lane record** (`lanes.ts`, validated by `validateLane`; `LaneStore.update` may change the new fields):

```ts
plan?: { planId: string; jobKey: string; planTitle: string; startsFrom?: { title: string; commit: string }[] };
/** The lane HEAD that Merge merged. */
mergedHead?: string;
```

**The first prompt:** `lanePreamble` adds this, and stays one line under 4000 characters:

> This lane runs job "Build API" of Hydra plan "Checkout". It starts from the work of Schema (a1b2c3d4e5f6). Stay within src/api/ if you can. When the work is ready, commit it; the user marks the job done or merges the lane.

**When it can't start yet:**

| Situation | What happens |
| --- | --- |
| 24 lanes are open (`maxOpenLanes`) | The job waits ("Waiting: 24 lanes are open"), and starts when a lane closes. |
| This build has no terminals | **Run plan** refuses up front, and names the lane jobs to switch to Head. |
| The CLI is missing, or the dependencies conflict | The job fails with the reason, and its dependents are skipped. |

### What "done" means for a lane job

Either of these, whichever comes first:

- **Merge.** The lane merges into its target as today. `LaneService.merge` records `mergedHead`, the lane HEAD it merged. The runner then records `result` with `via: 'merged'` and that commit.
- **Mark job done**, a new lane action for when later jobs should start before you merge:
  1. It refuses if the lane has uncommitted changes (offering **Commit…**, as Merge does), or no commits beyond its base ("Nothing to hand on yet").
  2. It runs the gates, as Merge does (section 3).
  3. It asks for an optional note, "What should the next jobs know?", defaulting to the commit subjects. Esc cancels.
  4. It records `result` with `via: 'marked'` and the lane's HEAD.

  The lane stays open, and you can merge it later.

**The result doesn't move.** Later commits in the lane don't change it, since the next jobs have already started from it. The tile says "Job done at a1b2c3d · 2 newer commits not handed on."

**Why both:** Merge is the natural end for a job nothing depends on. Mark job done lets a chain go on without merging half-finished work into main.

### Heads that depend on a lane job

- **Creating the head:** the runner creates it once the lane jobs it depends on are done, through a new method, `HelperService.startForPlan(args, lead, inputs)`. `args` are the same as today's `hydra_start_head` call. `inputs` are the lane results.
- **Storing them:** `Job.inputs?: DependencyResult[]` is saved with the job, so a queued head keeps its inputs across a restart. `parseJobInput` never reads `inputs` from a lead's call.
- **Launching:**
  - `startHelper` counts `inputs` as dependencies, so the head's base is worked out when it launches;
  - `launch` passes `[...dependencyResults(job), ...job.inputs]` to `dependencyBase` and `dependencyBrief`;
  - the brief's header becomes "What the jobs you depend on did" when any input is a lane.
- **`hydra_get_head`** shows the real `base_commit`, as today.

### Failures

| What happens | The job | Jobs that depend on it |
| --- | --- | --- |
| Its lane is closed (Keep branch or Delete everything) without a result | Failed: "Lane closed before its job was done (branch lane/x kept)." | Skipped. None has started, because they wait for it to be done. |
| **Cancel job**, on the lane or on the job's node | Cancelled. The lane stays open as an ordinary lane, and its plan link is removed. | Skipped |
| Its head fails or is cancelled | As today | Heads already created are failed by `HelperService`. Jobs not started are skipped. |
| Its head fails on a usage limit | Held | They wait. **Continue in <Other>** brings the head back (`continueWith`), and they go on. |
| It can't start | Failed, with the reason | Skipped |

**Before you close:** closing a plan lane whose job isn't done warns you first: "This lane runs job Build API of plan Checkout. Closing it without marking the job done fails the job, and 2 jobs that depend on it won't start."

### Plan state

```
draft → running → done
           ↓  ↑
       incomplete        (Retry failed jobs, or Run plan after adding jobs)
```

- **running → done:** every job is done.
- **running → incomplete** (new): no job is waiting, active or held, and at least one isn't done.
- **incomplete → running:** press **Retry failed jobs** on the plan node.
  - It clears `jobId`, `laneId`, `result` and `outcome` from failed, cancelled and skipped jobs, adds 1 to their `attempt`, and advances.
  - A retried head's idempotency key is `plan-<id>-<key>-r<attempt>`, because the old key would return the old head.
  - A lane or branch kept from a failed try is left alone.
- **`failed`** keeps its one meaning: planning a brief failed.
- **`finishDonePlans`** becomes part of `PlanRunner.advance`.

### Re-runs and restarts

- **Idempotent:** a job with a `jobId` or a `laneId` is never started again. **Run plan** on a running plan starts only jobs that were added since.
- **A crash between creating a lane and saving the plan:** the next advance finds the open lane whose `plan` link names the job, and records its `laneId`. For heads, the idempotency key already covers this.
- **After a restart:**
  - Lanes are exited and still belong to their plan; **Resume** works as for any lane.
  - Heads that were running have been failed by `JobStore.load`, and the plan shows it.
- **No terminals at startup:** Hydra never opens a lane terminal while a window is starting. A lane job that is ready at startup shows **Start lane** on its node instead.

## 3. Gates and usage limits

### Gates

- **Merge:** a plan lane's Merge runs the gates as any lane's does (`lanes: "onMerge"`).
- **Mark job done** runs the same gates flow under the same policy, because it hands work on, just as a head's `hydra_done` does. If they fail, the choices are **Send to lane** (the default), **Mark done anyway** and **Cancel**.
- **No double run:** `LaneGatesRecord` gains `commit`, the lane HEAD the gates ran on (recorded only when the lane was clean). Merge reuses a passing run on the same commit instead of running the gates again: "Gates passed on a1b2c3d at 3:40 PM."
- **The base the lane is measured from** (`laneDiffBase(lane)`):
  - normally the merge-base with the target, as today;
  - while the lane's `baseCommit` isn't in the target yet (the lane started from unmerged dependency work), the `baseCommit` itself. The reviewer and the tile then see only this job's work.

  Diff, the changed-files count and the gates all use it.

### Usage limits

- A plan lane that hits its usage limit behaves as any lane: the banner, **Continue in <Other>**, and `hydra.lanes.onLimit: "switch"`.
- It stays the plan's lane, and its job isn't failed.
- The job keeps the provider it asked for. The canvas shows the lane's current provider, with "Continued from Claude Code (limit)".
- A head job that hits its limit is held, not failed (section 2).

## 4. Canvas

Running, incomplete and recently finished plans get their own group, like a draft plan's, with heads and lanes together.

**The plan node:**
- a lead node of kind `plan` (key `plan-<id>`), labelled "Plan · Checkout";
- its status: "2 of 4 done · waiting for you in Build API", or "Incomplete · 1 failed";
- its actions: **Retry failed jobs** (when incomplete) and **Delete plan**. For a running plan, Delete asks first and doesn't stop its heads or lanes.

**One slot per job**, laid out by job depth (dependents to the right), with the same column rule as drafts. Each slot shows the job's current node:

| Job | Node |
| --- | --- |
| A head on the canvas | The ordinary head card |
| A head that has left the canvas (merged, or moved to the tray) | A small "Done" or "Failed" job node, so the plan's graph stays whole |
| A started lane job | A **lane card**, the size of a head card. It shows the provider logo, "Lane", the job title, the lane's status ("Working · lane/build-api", "Exited", "Job done · a1b2c3d" or "Closed before done") and its gate chips. Clicking it opens the Lanes view on its tile. Its ⋯ menu: Open lane, Mark job done, Cancel job, Diff. |
| A job not started | A dashed node: "Waiting for Schema, Auth", "Starts as a lane when Schema is done", **Start lane** (after a restart), "Skipped: Schema did not finish" or "Cancelled". Its ⋯ menu: Cancel job. |

**Edges:**
- `plan-lead`, from the plan node to jobs with no dependency;
- `plan-dependency`, between jobs, whatever fills their slots;
- `waiting` styling while the dependent hasn't started and the dependency is active, and the flow animation while the dependent is active.

**Heads a plan lane starts** (its agent calls `hydra_start_head`) sit in the column after its lane card, joined by a `lead` edge. They aren't plan jobs and don't count toward the plan.

**A plan lane isn't drawn twice:** it isn't also drawn as a separate lane node. Its conflict edges attach to its lane card.

**When a plan leaves the canvas:** running and incomplete plans stay. A done plan stays while any of its heads is on the canvas or any of its lanes is open, then leaves as a chat does.

**Code:**
- `buildCanvas` gains a plan pass. `CanvasLead.kind` adds `'plan'`, and `CanvasModel` gains `planLanes` and job-slot nodes with a `status`.
- Heads grouped under `plan-<id>`, or under one of the plan's lanes, are laid out by the plan's job graph instead of by their `dependsOn` ids.

## 5. Lanes view and the Hydra panel

- **`LaneView.planJob`**, filled in by the extension: `{ planId, planTitle, jobTitle, state, commit? }`.
- **Tile header:** a chip "Plan · Checkout › Build API", with the tooltip "Jobs after it start when you mark it done or merge it". Once the job is done, a green "Job done · a1b2c3d" chip.
- **Tile footer:** for an unfinished plan lane, **Mark job done** sits next to Merge.
- **⋯ menu:** **Cancel job…** and **Show plan**, which opens the canvas centred on the plan.
- **`laneActions`** gains `markJobDone`, `cancelJob` and `showPlan`. For automation, `hydra.lanes.action` takes the note as an option.
- **Hydra panel:** a plan lane's description adds "Plan: Checkout". A plan reads "Running · 2 of 4 done · 1 lane", or "Incomplete · 1 failed".
- **`hydra_lanes`** adds `plan: { title, job, dependents }` to a plan lane, so other lanes' agents know.

## 6. Planning a brief

The planner doesn't suggest `runAs`; its jobs are all heads.

- **Nothing to change in the parser:** `parsePlanJobDraft` already drops unknown fields, so a `runAs` in the planner's reply is ignored.
- **Why not:** a lane needs you at the keyboard, and the planner can't know when you are. A lane's brief is also capped at 2000 characters, while a planned brief can run to 4000.
- **Instead, you switch jobs yourself.** The popover gets a segmented **Run as: Head · Lane** control under Provider. Under Lane, a note says: "You drive it in a terminal. Its brief becomes the lane's goal (up to 2000 characters)."
- **Later, if wanted:** an option on the New plan card, "Suggest lanes for jobs that need judgment", which adds `runAs` to the planner's prompt (open question 4).

## 7. Code layout

| File | Change |
| --- | --- |
| `src/core/plans.ts` | The `PlanJob` fields, validation, `incomplete` and `planLaneBriefMax`. The runner takes over from `runPlan`, `jobsToStart` and `allJobsDone`. |
| `src/core/planRunner.ts` (new) | `planSteps` (pure) and `PlanRunner` (a queue per plan, reconciling, starters) |
| `src/core/headStart.ts` | `DependencyResult.kind`, and `dependencyBrief`'s header |
| `src/core/jobs.ts` | `Job.inputs` and `JobInput.inputs` (internal only) |
| `src/core/helperService.ts` | `startForPlan`, and `inputs` in `startHelper` and `launch` |
| `src/core/lanes.ts` | `Lane.plan`, `Lane.mergedHead`, `laneNameFromTitle`, the plan sentence in `lanePreamble`, and `LaneGatesRecord.commit` |
| `src/core/laneService.ts` | `create(…, { baseCommit, plan })`, `mergedHead` on merge, reusing a gates run, and `laneDiffBase` |
| `src/core/laneFinish.ts` | `laneDiffFiles` takes its base from `laneDiffBase` |
| `src/extensionLanes.ts` | Mark job done, Cancel job, Show plan, the close warning, `startPlanLane`, and `LaneView.planJob` |
| `src/extension.ts` | `runPlanById` hands over to the runner; advancing on head and lane changes; Retry failed jobs; the plan lookups `LanesHost` needs |
| `src/core/model.ts` | `planSaveJob.runAs`; new `planRetryJobs`, `planCancelJob` and `planStartJob` messages; the new lane actions; views |
| `src/core/agentsCanvas.ts`, `webview/AgentsCanvas.tsx` | The running plan group, lane cards, job slots and edges, and **Run as** in the popover |
| `webview/LanesView.tsx`, `src/core/hydraTree.ts` | The plan chip and actions, and the panel's descriptions |

[Packs_Plan.md](Packs_Plan.md) also changes `PlanJob` and the job popover, to add roles. Build this plan first.

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | Core: the `PlanJob` fields and validation; plan states; `planRunner.ts` (statuses, readiness, the queue per plan, reconciling); `Job.inputs` and `startForPlan`; `LaneService.create` with a base and a plan link; `mergedHead`; `laneDiffBase`. Unit tests with fake starters and real temp repos. | **Opus**: ordering, idempotency, git |
| 2 | Wiring: Run plan through the runner; advancing on head and lane changes; Mark job done and Cancel job with the gates flow; the close warning; failures and dependents; Retry failed jobs; reusing a gates run. | **Opus** |
| 3 | UI: **Run as** in the popover; the running plan group on the canvas; the tile's plan chip, button and menu; the Hydra panel; `hydra_lanes`. After 1, in parallel with 2. | **Sonnet** |
| 4 | Live checks, and docs (the Plans and Lanes sections of Heads.md, README, and this plan's "As built"). | **Opus** |
| 5 | Local gate, PR, CI, merge, light refresh of the installed app, and ping Nico. | **Opus** |

## Acceptance

**Unit tests:**
- **Validation:**
  - `runAs` values;
  - `jobId`, `laneId` and `result` only on the right kind of job;
  - the lane brief cap equals `laneGoalMax`;
  - never both `result` and `outcome`;
  - an old plan with no `runAs` loads as heads.
- **Readiness:**
  - a lane job waits for all its dependencies;
  - a head waits for the lane jobs it depends on and for its head dependencies to start, but not for those heads to finish;
  - a chain of heads behind a lane is created in one pass;
  - a plan with only heads creates every head at Run, as today.
- **Idempotency:**
  - two advances at once start each job once;
  - Run plan again starts only new jobs;
  - a lane whose plan link names a job with no `laneId` is adopted.
- **Failures:**
  - a lane closed without a result fails its job, and its dependents are skipped;
  - Cancel job cancels it and removes the lane's plan link;
  - a head that hit its limit holds its dependents, which go on after `continueWith`.
- **Plan state:** done; incomplete; Retry failed jobs goes back to running with `-r1` keys.
- **Starting points** (real temp repos):
  - a head starts from a lane's result and sees its file;
  - a lane starts from two heads' results, merged;
  - conflicting dependencies fail the job with the files named;
  - the brief says "the jobs you depend on".
- **Lanes:**
  - `create` with a base commit;
  - `mergedHead` is recorded on merge;
  - Mark job done refuses a dirty lane and a lane with nothing to hand on, and records HEAD and the note;
  - Merge reuses a passing gates run on the same commit;
  - `laneDiffBase` gives the base commit while dependency work isn't in the target, and the merge-base afterwards.
- **Text:** `lanePreamble` has the plan sentence and is still one line under the cap. `laneNameFromTitle` always gives a valid lane name.
- **Canvas model:**
  - a running plan with a head, a lane card and a waiting job, with the edges between them;
  - a plan lane isn't also drawn as a separate lane node;
  - heads started by a plan lane sit after it;
  - a head that left the canvas keeps a small done node.
- **Parsing and views:**
  - `parseMessage` for `planSaveJob` with `runAs`, and for the new lane actions;
  - SSR of the tile's plan chip and of the lane card;
  - the Hydra panel's descriptions.

**Smoke:**
- A plan with lane job A (using `HYDRA_TEST_LANE_COMMAND`) and head job B depending on it:
  - Run plan starts A's lane, and B isn't created;
  - after a commit in A, `hydra.lanes.action(A, 'markJobDone', { message })` creates B, and B's `base_commit` is A's HEAD.
- A plan with a lane job is refused when terminals aren't available.

**Live** (isolated probe window, real CLIs):
1. A plan where A is a lane (Claude), B is a head depending on A, and C is a lane (Codex) depending on A. Run it. A's lane opens with the plan sentence in its first prompt, and B and C show as waiting on the canvas.
2. Commit in A and press **Mark job done**. The gates run and the note is asked for. B starts from A's commit (check `base_commit` in `hydra_get_head`), and C opens from A's commit.
3. Close C with Keep branch before it's done. C fails, and the plan becomes Incomplete once B is done. **Retry failed jobs** opens a new lane for C.
4. Merge the new C. Its job is done by merge, and the plan becomes Done.
5. Simulate a limit in a plan lane (`hydra.debug.simulateLimit` with its id). **Continue in Codex** keeps the lane under the plan, and the job isn't failed.
6. Reload the window mid-plan. The plan's lanes show Exited under the plan and Resume works. No lane opens by itself.

**Done** when the local gate passes (check, build, tests, smoke), the live checklist passes, the PR is merged with CI green, the installed app is refreshed, and Nico has the summary.

## Decisions (Nico, 2026-09-25)

1. **A lane job starts working at once:** its brief is the first prompt, like New lane with a goal. You can type to it at any time.
2. **Long briefs go in a file.** The full brief is written to a file the lane can read (outside the tracked tree, never committed), and the first prompt points to it. The 2000-character cap goes.
3. **Mark job done can be pressed again** to move the result forward, while no dependent has started.
4. **The planner doesn't suggest lanes yet.** Later.
5. **+ Job works on a running plan** as well as on drafts.
6. **A lane's agent may ask for done:** a `hydra_job_ready` action shows you a **Mark job done** prompt. It never marks the job itself.
7. **Heads queued behind a head that hit its usage limit wait** instead of failing, so **Continue in** can still save them. Fixed in phase 1.

## As built

Built on 2026-09-25.

**Where it lives:**
- **Model:** `src/core/plans.ts` (`runAs`, `laneId`, `result`, `outcome`, `attempt`, `draft`, and the `incomplete` state).
- **Runner:** `src/core/planRunner.ts` (`planSteps`, `PlanRunner`, `planLaneBrief`).
- **Lanes:**
  - `src/core/lanes.ts`: the plan link and `lanePreamble`'s plan sentence.
  - `src/core/laneService.ts`: `create` with a base commit, `writeLaneJobBrief`, `handOn` and `reusableGates`.
  - `src/core/laneSync.ts`: `laneDiffBase`.
- **Extension and views:**
  - `src/extensionLanes.ts`: Mark job done, Cancel job, Show plan and `startPlanLane`.
  - `src/core/agentsCanvas.ts` with `webview/AgentsCanvas.tsx`: the running plan group.
  - `webview/LanesView.tsx`: the plan chip and Mark job done.
  - `src/core/hydraTree.ts`: plan progress.
  - `hydra_job_ready` is in `helperTools.ts` and `mcpBridge.ts`.
- **Tests:**
  - Unit: `tests/planRunner.test.ts`, `tests/planLanes.test.ts`, plus canvas, Lanes view and panel cases.
  - Smoke: the plan-lane case in `tests/smoke.ts`.

**Changes from the plan:**
- **Lane card status:** a working lane card says "Working". Its branch is on the card's foot, so the status fits the card.
- **Plan heads keep their own menu:** a head started by a plan keeps its ordinary head card and menu, with no separate job menu.
- **The lane's `brief.md`** ends with what the jobs before it did (their notes or commit subjects, and files), as a head's brief does. Without this, the Mark job done note never reached a dependent lane.
- **+ Job on a running plan:** the new job stays an editable draft card until Run plan starts it.
- **Merged lanes:** a merged lane doesn't offer **Mark job done again**, and the action is refused.
- **Windows quoting:** `processLaunch` now doubles PowerShell's typographic quotes (‘ ’ ‚ ‛) in `.cmd` launches. A brief with "it’s" used to end the quoted argument. This was found while building Packs.

**Verified live** (2026-09-25, an isolated probe window with the real CLIs, a scratch repository with one command gate):
1. **Start:**
   - Greeting (a Claude lane) opened with the plan sentence and the brief file in its first prompt.
   - Shout (a head) showed "Waiting for Greeting".
   - Farewell (a Codex lane) showed "Starts as a lane when Greeting is done".
2. **Mark job done:** after Greeting's agent committed, Mark job done ran the gate and asked for the note.
   - Shout started from Greeting's commit and finished.
   - Farewell opened from the same commit, with the plan sentence.
3. **Close and retry:** closing Farewell with Keep branch failed its job ("Lane closed before its job was done (branch … kept)"), and the plan read "Incomplete · 1 failed".
   - Retry failed jobs opened a new Farewell lane.
   - Its `brief.md` carried Greeting's note.
4. **Merge:** merging the new Farewell finished its job by merge. With the last job marked done, the plan read Done, "4 of 4 done".
5. **Usage limit:** a Claude limit was simulated in a plan lane, using the real hook script and the probe's own events folder.
   - The tile offered Continue in Codex.
   - After continuing, the lane stayed under the plan and the job wasn't failed.
6. **Reload mid-plan:** the plan's lanes showed Exited under the plan, and nothing started by itself. Resume restarted a lane.

**Not verified live:**
- **`hydra_job_ready` from a Claude lane:** the probe's Claude was connected to the installed Hydra, whose server predates the tool. It is unit-tested, and the Codex lane's own bridge carried `HYDRA_LANE_PLAN_JOB`.

**Not done:**
- **Resume without a conversation:** Resume in a lane whose CLI never began one (it stopped at its own update or folder-trust prompt) opens an empty session. **Start fresh** works. This is how lanes already behave.
- **Planner suggestions:** the planner doesn't suggest Head or Lane (decision 4).

