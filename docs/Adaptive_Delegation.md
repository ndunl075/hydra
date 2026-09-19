# Adaptive delegation and focused subagent context

Status: Phase 1 host preparation and two Phase 2 slices are implemented; automatic decomposition is not implemented. Nico requested this feature on 17 September 2026. Hydra persists a conservative Solo/Auto planning preference, validates and stores host-bound plan decisions, and exposes preferences in the composer, Settings, and host snapshot. An explicit host command reserves and creates child worktrees from recorded decisions with durable dispatch keys, then persists matching idle Hydra child tasks with a parent/dispatch link. It does not queue or launch children, send a planner turn, or demonstrate savings.

## Product behavior

When Nico submits a prompt, the main agent decides whether to complete it itself or delegate independent pieces to subagents. Choose the least total work likely to meet the requested quality. Faster completion and fewer tokens are separate outcomes; a prediction is not a measured saving.

The intended released default is **Auto**, with a persistent **Solo** override in the composer and Settings. During development Auto remains opt-in until the acceptance and efficiency gates below pass. Solo disables Hydra-managed delegation; only promise fully single-agent execution if the provider exposes a verified way to disable its own nested agents. Explain unsupported native controls instead of claiming enforcement.

Show a short decision such as “Working solo: one localized change” or “Splitting into two independent tasks: settings UI and import parser.” Decisions and child briefs are inspectable without requiring another approval for every routine spawn. Existing command, file, network, setup, and integration permission boundaries still apply. Changing modes affects future delegation; it never silently cancels running work.

A padding fix stays solo. A cross-file bug with one unresolved root cause starts with one investigator. An onboarding UI and an independent import parser may run in parallel after their shared interface is agreed. Integration and final acceptance remain serialized.

## Decision and execution contract

1. Assess delegation inside the main agent's normal working turn after enough bounded inspection to understand the task. Do not run a separate expensive planner for every prompt or make model requests when the user merely opens the graph.
2. Delegate only concrete, independently useful subtasks with clear ownership and acceptance criteria. Consider coupling, shared files, unknown interfaces, duplicated discovery, setup cost, expected review/integration work, capacity, and reported budget headroom. Stay solo when benefit is unclear; record a short rationale, not hidden reasoning.
3. Return a structured proposal that local Hydra code validates before creating children. Include parent/plan IDs, a unique child key, goal, write scope, selected base commit, dependencies, context manifest, provider/model/effort, limits, and deliverable. Reject malformed proposals, cycles, invalid bases, unsupported settings, and unauthorized scope expansion. The model proposes work; the host enforces policy.
4. Use one delegation level initially. Default to at most two children across a parent's entire run, including replacements; retries and replanning cannot reset this counter. Increases require an explicit setting. Children cannot spawn Hydra grandchildren. Constrain provider-native delegation where supported; otherwise disclose that its hidden fan-out and usage are outside the managed limit.
5. Reuse the scheduler and its configured capacity, default two active managed processes per window. Count the main agent while running, children, and other tasks in the same pool. Persist the plan and release the main agent's active slot while awaiting children so queued work can proceed. Prevent idle model turns and repeated model polling.
6. Give each writing child its own branch/worktree at a recorded base. Define shared interfaces before parallel edits; serialize overlapping write scopes or assign them to one owner. Scope is an assignment, not a filesystem sandbox. Reuse trusted setup and distinct service resources. Unknown external writers block unsafe scheduling; do not imply account-wide or cross-window enforcement before it exists.
7. Resume the parent on durable child-result events, coalescing simultaneous completions and deduplicating wakeups. The parent may continue useful independent work while children run, within the same capacity and ownership rules.

## Context supplied to a child

Start a fresh child session with a bounded brief rather than a fork of the full parent conversation. The inspectable context manifest records exactly what Hydra supplied and why:

| Required item | Content |
| --- | --- |
| Task and quality target | Objective, relevant user intent, acceptance criteria, and suggested validation commands |
| Shared constraints | Applicable repository instructions, user constraints, relevant architectural decisions, and agreed interface contracts |
| Ownership and source state | Worktree, base commit, assigned paths/symbols, dependencies, and areas another agent owns |
| Focused evidence | Necessary source excerpts or selected dependency-result artifacts, with paths, revisions, provenance, and unresolved caveats |
| Execution settings | Provider and effective model/effort, delegation limits, and launch/turn budgets |

Use existing brief bounds initially (32,000 characters for the rendered initial brief); a character limit is not a token budget. Preserve mandatory instructions and acceptance criteria. If a brief will not fit, reduce optional excerpts, use source references, or refuse and revise the proposal rather than silently truncating requirements.

Do not inject all open files, the entire repository, parent/sibling transcripts, unrelated histories, credentials, or hidden reasoning. Necessary constraints must survive transcript omission. The manifest covers Hydra-supplied content, not invisible provider prompts or provider-owned context management.

Children can inspect relevant files with ordinary authorized tools and request missing context or clarification. Provide selected evidence with source references, not bulk history replay. Re-read changed sources and invalidate stale interface/dependency artifacts. Retrieved code and agent output are evidence, never permission to broaden scope. Do not filter live tool results or force repeated compaction behind the user's back.

## Results, review, and recovery

### Parent suspension and resume contract

| Durable parent state | Trigger | Scheduler/session effect | Next state |
| --- | --- | --- | --- |
| `running` / `waiting-for-approval` | Enrolled children begin | Build and persist a detached `waiting-for-children` candidate, swap it live, then stop the existing managed process. This releases the scheduler slot without deleting the recorded session. If stopping fails, persist and restore the prior active state. | `waiting-for-children` |
| `waiting-for-children` | One or more result receipts arrive | Store each immutable receipt first. A reconciliation pass coalesces all receipts then persists one SHA-256 wakeup key before queueing one existing-session follow-up. | `queued` / `running` |
| `waiting-for-children` | Any prerequisite fails, is interrupted, or is cancelled | Keep every sibling receipt in the journal and persist a blocking reason. | `blocked` |
| `waiting-for-children` | Stop/cancellation | Do not queue a new wakeup. Existing receipts and the stored session remain inspectable. | `cancelled` |

On restart, reload the journal and the parent schedule. A stored wakeup key suppresses redelivery; a persisted receipt without a key is reconciled once. The waiting transition always writes before the irreversible session release and compensates both durable and live state if release fails. Retrying a child writes its one-attempt receipt before invoking the scheduler. Replanning never clears that receipt. No polling, heartbeat, recursive child, provider launch, or integration promotion is part of this transition.

Each child returns a concise result containing decisions, changed paths, exact commit/tree references, validation commands and outcomes, unresolved problems, and pointers to complete local evidence. Produce this in its normal completion; opening a task or handoff must not trigger another summarization call. Retain full available logs locally without automatically inserting them into parent context.

The parent inspects actual changes, checks shared contracts, and uses existing prepared-review and candidate-integration gates. Individual child tests do not replace combined acceptance tests. A successful model turn or a “done” summary alone never completes the parent. Conflicts, stale receipts, missing evidence, and failing checks preserve recoverable work and block integration.

Persist plan version, relationships, context manifests, starting commits, dispatch keys, provider session IDs, result receipts, usage provenance, and graph events. Restart must not replay launches or resend accepted results. Reconcile uncertain writers before retrying. Failed prerequisites block dependents. Cap automatic retries at one per child, charged to the same run budget; further attempts require an explicit decision.

**Stop task and agents** cancels pending children, prevents new dispatch/wakeup work, and requests interruption of owned active sessions. Preserve worktrees and histories. Uncertain provider stops remain interrupted or awaiting reconciliation. A child failure may allow useful independent siblings to finish, but cannot produce a successful parent result.

## Budgets, model choice, and visible flow

Children inherit the parent's selected provider/model/effort unless an explicit user policy says otherwise. Verify effective selections through supported adapters; never silently choose a cheaper model or switch subscription work to API billing. Start with separately managed child sessions using supported provider interfaces, not undocumented native subagent APIs. Enable Auto per provider only after its orchestration, approval, interruption, and resume gates pass.

Aggregate planning, children, retries, synthesis, review, and validation usage under the parent run and project. Deduplicate provider thread totals; establish whether parent usage includes native children before summing. Missing coverage stays **Unavailable/partial**, not zero. All managed children use existing task/project budget holds, with a parent-run launch/turn guard. Serialize sibling budget checks and account for pending reservations where meaningful estimates exist; unknown or in-flight usage is not guaranteed remaining budget. Limits remain soft, not strict in-flight spending caps.

Extend the graph with persisted parent-to-child assignments, dependencies, context requests, and result handoffs. Animate actual dispatch or delivered-result events with provenance; stop activity at approvals and respect pause/reduced motion. Show decision rationale, context manifests, active/queued/blocked states, and parent-run usage. Do not fabricate live message traffic or imply exact token flow from animations.

## Verification evidence and focused agent workspace

Planned additions from the [Ninebrains review decision](Agentic_Workflow_Architecture.md#ninebrains-review-decision-2026-09-18); not implemented by this documentation change.

Phase 3 adds a per-attempt evidence panel recording the exact checked commit/tree, check identity, command and exit status, review findings, relevant screenshot artifacts, timestamps, and retry history. Preserve full local artifacts; summaries link to evidence rather than copying entire logs into context. Each explicit check declares a bounded timeout from one second through fifteen minutes; timeout stops the owned command and records a failed check with retained output. Required gates remain blocking when their runner is missing, evidence is absent, execution is interrupted, the check fails, or the checked snapshot becomes stale. Optional/not-applicable checks are explicitly distinguished from passed checks. An evidence attempt with no required checks records that no child-level gate was required; it does not claim verification passed and does not bypass normal combined integration acceptance. Version 1 keeps an immutable attempt history for one reviewed commit/tree. When a later reviewed child commit/tree differs, the host can prepare a detached result-boundary archive candidate that retains the prior evidence and records the replacement identity. It must not apply that candidate until a host-owned serial transaction can save the complete task and swap live state under the same mutation fence; this feature does not introduce a new asynchronous archive writer. The archived evidence is not active acceptance evidence, so new checks are required before combined acceptance. Exact archive replay is a no-op, conflicting identities fail, and no archive record auto-integrates or replaces prior facts. A shutdown that arrives during the durable save rewrites the latest attempt as interrupted before the action settles, so reload cannot retain that racing action as passed. Keep the existing one-retry limit and combined integration acceptance; use model review and screenshots only where appropriate to the acceptance criteria.

Phase 4 adds a focused agent workspace opened from the graph: worktree/branch identity, the correct terminal/session, diff, evidence, and available preview. Display queued, running, validating, blocked, and completed states from persisted host events, keeping execution completion distinct from accepted completion. Preserve the native Editor layout. Opening or switching views must not launch agents or previews, run checks, or submit model requests; stopped/unavailable resources stay explicit.

Acceptance additions: Phase 3 fixtures cover missing runners, absent artifacts, interrupted checks, failed checks, stale receipts, retained retry evidence, and a passing child whose combined integration fails. Phase 4 checks correct worktree/session selection across multiple agents, restart recovery of evidence and status, unavailable previews, zero side effects from navigation, and event-backed arrows with reduced-motion support.

## Delivery and acceptance

Ship each phase as a separate tested feature PR. Existing manually created tasks remain usable throughout.

| Phase | Deliverable and gate |
| --- | --- |
| 1. Plan contract and context | Versioned proposal schema, Auto/Solo controls, manifests, persisted decisions, and host validation. Fixtures prove localized work stays solo, independent tasks are eligible, overlapping tasks are serialized, and required constraints survive without transcript copying. Evaluate real model decisions separately from fixtures. |
| 2. Managed delegation | First slice implemented: recorded decisions receive durable, deterministic dispatch/worktree identities before Git creation; failed or interrupted creation becomes an unresolved receipt and cannot auto-retry. The explicit materialization command does not create a Hydra child task or launch a provider. Remaining: child task creation through the shared queue, parent suspension/wakeup, stop/recovery, capacity and budget holds, retries/replanning, and reconciliation UI. Cover two-slot capacity including the parent, simultaneous completions, restart during dispatch, provider failures, and no duplicate writers/launches. |
| 3. Results and integration | Small evidence-linked results, missing-context requests, stale-artifact detection, parent review, and combined acceptance. Prove that children retrieve needed source without unrelated history, failed prerequisites block, conflicts preserve work, and child success cannot bypass integration checks. |
| 4. Graph and accounting | Actual assignment/handoff events, inspectable briefs, effective settings, parent-run usage, and partial-coverage labels. Verify zero model requests from graph viewing, no duplicate accounting on resume, native coverage limits, and cancellation/approval/reduced-motion behavior. |
| 5. Live acceptance and rollout | Bounded authenticated runs for each advertised provider cover edits, tests, approvals, stop/restart/resume, and review. Compare Auto against Solo on matching tasks/base commits/models/effort with repeated runs. Enable Auto by default only after the quality and efficiency gate below passes. |

Before evaluation, freeze representative tasks spanning localized edits, independent features, coupled refactors, investigation, and failure recovery. Record provider-reported usage where complete, elapsed time, acceptance pass rate, regressions, integration conflicts, and manual rework. Include coordination and retries; report missing measurements instead of filling them in.

Predeclare tolerances and sample sizes before benchmarking. Require no material quality regression and improvement in total usage or completion time within the user's declared usage budget. Report which outcome improved and its tradeoff; a faster, more expensive run is not token-efficient. If Auto cannot reliably choose worthwhile splits, retain Solo as default and Auto as opt-in until the policy improves.
