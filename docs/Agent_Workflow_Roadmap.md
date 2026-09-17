# Agent workflow roadmap

Nico's goal is a Hydra IDE where multiple agents work in parallel in isolated Git worktrees, their results can be integrated safely, and avoidable token use falls without reducing output quality. This roadmap records the gaps found by an Astra high-effort review on 17 September 2026. It describes planned work, not shipped capabilities or demonstrated savings.

## Current foundation

Hydra creates a branch and worktree for each task, records its base commit, and prevents overlapping writers to that task. Managed sessions use supported provider session/thread resume. Native review captures immutable diffs; local UI and Git operations require no model call. Raw provider events and reported per-turn usage are retained.

The configurable managed-task limit defaults to two and is capped at eight per window. Both terminal and managed-session launches currently refuse at capacity; neither has a persistent queue. Official-extension sessions are externally owned and are not counted by this limit. A worktree isolates checked-out files, not ports, databases, dependency services, or every filesystem access available to an agent. Authenticated provider acceptance, integration/discard, aggregate usage, and measured efficiency remain incomplete. See [implementation status](Implementation_Status.md).

## Delivery priorities

Each implementation ships in a separate feature PR with its own acceptance checks. These priorities complement the [desktop delivery track](Desktop_Delivery.md); onboarding, account connection, and a tested installer remain required.

### 1. Safe integration and quality gates

Complete M4 before expanding concurrency. Bind review and acceptance results to the exact commit and working-tree state. Serialize integration into a clean target, detect changes since review, and preserve recoverable state on conflicts. Discard must be explicit and preserve unrelated work.

Acceptance: two independently edited tasks can be reviewed and integrated in order; stale reviews and dirty targets refuse; conflict recovery preserves both tasks and the target. Show the relevant test results and unresolved issues before integration. An agent declaring completion is not proof that the task passed its acceptance criteria.

### 2. Persistent scheduling and dependencies

Queue excess work instead of refusing it. Persist queued, starting, running, waiting-for-approval, blocked, interrupted, and finished states. Define cancellation, restart reconciliation, and capacity accounting for each launch interface. Keep approval requests visible in Attention. Show external sessions separately rather than implying that Hydra controls their concurrency.

Add explicit task dependencies and a selected starting commit. Dependent tasks may start from a verified predecessor result, rather than always from the main checkout's HEAD. Detect dependency cycles and require explicit resolution of failed or changed predecessors.

Acceptance: queue more tasks than the limit, restart Hydra, and launch each eligible task once without duplicate writers. Failed prerequisites remain blocked. Each launched task records its actual starting commit and dependency artifacts. Increasing parallelism is an explicit user choice, not a token-saving claim.

### 3. Focused task briefs and useful handoffs

Provide editable goals, constraints, relevant paths, acceptance criteria, and test commands. Keep context inclusion explicit; do not automatically attach the entire repository, all open files, or every agent transcript. Resume related work through the provider's native session mechanism.

Completion and handoff summaries should record decisions, changed files/commits, validation, and unresolved work, with pointers to full local evidence. Pass dependency results as small, reviewed artifacts rather than replaying another agent's whole conversation. Do not create extra summarization calls merely because the user switches tasks or views.

Acceptance: the user can inspect the exact task brief and handoff, unrelated tasks receive no prior transcript automatically, and a dependent agent can locate the predecessor's verified result without redoing discovery.

### 4. Model, effort, usage, and launch budgets

Expose per-task model and reasoning effort only through supported provider controls, and show the effective selection. Nico's preferred Astra High preset should be available when the official provider/runtime exposes that model and effort. Offer explicit choices for routine work; never silently downgrade a difficult task or substitute API-key billing for subscription authentication.

Persist reported usage with its provider semantics and aggregate it by task and project without double-counting cumulative events. Distinguish input, output, cached usage, monetary estimates, and subscription limits. Missing measurements remain unavailable. Soft budgets can warn or hold new turns and queued launches; do not promise an enforced in-flight spending cap without provider support.

Acceptance: effective settings survive resume; unsupported choices produce guidance rather than a false success; restart and repeated usage events do not inflate totals; budget warnings stop only the configured new work. UI transcript truncation or collapsing output is not recorded as model-token savings.

### 5. Real-provider workflows and repeatable setup

Validate realistic edit, test, approval, interruption, and resume flows for Claude Code and Codex. Complete missing permission handling before advertising those workflows as supported. Login and local setup must never submit a model turn.

Provide explicit, trusted dependency setup and resource assignments for task ports, databases, and services. Preserve diagnostics when setup fails; keep another task's setup and processes intact. This should prevent avoidable repair loops and duplicated setup work.

Acceptance: authenticated scratch tasks perform edits and tests with verified ownership and approvals; interrupted tasks resume without invented completion; parallel fixtures use distinct resources and cannot stop one another's processes. Real-provider tests must use an agreed bounded task budget.

## Efficiency and quality evidence

Compare Hydra with ordinary CLI/extension use on matching tasks, base commits, providers, models, effort settings, and acceptance tests. Repeat runs and record reported usage, completion quality, regressions, manual rework, and elapsed time. Optimize only when the comparison shows less avoidable work without a material quality drop. Correctness checks remain part of the budget.

The first release coordinates user-created tasks and explicit dependencies. Automatic task decomposition or autonomous agent swarms require a separate scope and acceptance plan. Parallel isolated agents are a core product goal; inexpensive, high-quality outcomes still require measurement.
