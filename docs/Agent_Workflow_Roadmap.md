# Agent workflow roadmap

Nico's goal is a Hydra IDE where multiple agents work in parallel in isolated Git worktrees, their results can be integrated safely, and avoidable token use falls without reducing output quality. This roadmap records the gaps found by an Astra high-effort review on 17 September 2026 and the subsequent partial implementation. Feature availability and completed gates are tracked in the [acceptance record](Implementation_Status.md#acceptance-record); no measured savings are claimed.

## Current foundation

Hydra creates a branch and worktree for each task, records its base commit, and prevents overlapping writers to that task. Managed sessions use supported provider session/thread resume. Native review captures immutable diffs; prepared reviews bind staged task trees to exact commit receipts, with stale-state and unsaved-buffer refusal. Local UI and Git operations require no model call. Raw provider events and reported per-turn usage are retained.

The configurable managed-task limit defaults to two and is capped at eight per window. Terminal and managed-session launches now share a persistent queue, with reviewed prerequisite receipts and explicit reconciliation of uncertain writers after restart; see [task scheduling](Task_Scheduling.md). Reviewed integration, explicit briefs/local handoffs, aggregate reported usage and verified Codex model/effort controls have merged after Linux and native checks. The final combined installer runtime also passed Windows acceptance. Official-extension sessions are externally owned and are not counted by this limit. A worktree isolates checked-out files, not ports, databases, dependency services, or every filesystem access available to an agent. Confirmed discard, authenticated provider acceptance, budgets, resource setup and measured efficiency remain incomplete. See [implementation status](Implementation_Status.md).

## Delivery priorities

Each implementation ships in a separate feature PR with its own acceptance checks. These priorities complement the [desktop delivery track](Desktop_Delivery.md); onboarding, account connection, and a tested installer remain required.

Onboarding, account setup and the installer have merged after automated checks. Live sign-in and the broader delivery gates remain outstanding. The acceptance criteria below retain the full intended scope even where only part has been implemented.

### 1. Safe integration and quality gates

Status: reviewed candidate integration, explicit acceptance checks, stale-state refusal and conflict recovery merged in PR #22. Confirmed discard remains unfinished; later combined revisions require regression acceptance. See [Integration.md](Integration.md).

Complete M4 before expanding concurrency. Bind review and acceptance results to the exact commit and working-tree state. Serialize integration into a clean target, detect changes since review, and preserve recoverable state on conflicts. Discard must be explicit and preserve unrelated work.

Acceptance: two independently edited tasks can be reviewed and integrated in order; stale reviews and dirty targets refuse; conflict recovery preserves both tasks and the target. Show the relevant test results and unresolved issues before integration. An agent declaring completion is not proof that the task passed its acceptance criteria.

### 2. Persistent scheduling and dependencies

Status: merged in PR #20 after native acceptance, with default capacity unchanged, selected bases, pinned reviewed predecessors, cancellation during startup and explicit restart reconciliation. Global capacity and environment resources are outside this milestone.

Queue excess work instead of refusing it. Persist queued, starting, running, waiting-for-approval, blocked, interrupted, and finished states. Define cancellation, restart reconciliation, and capacity accounting for each launch interface. Keep approval requests visible in Attention. Show external sessions separately rather than implying that Hydra controls their concurrency.

Add explicit task dependencies and a selected starting commit. Dependent tasks may start from a verified predecessor result, rather than always from the main checkout's HEAD. Detect dependency cycles and require explicit resolution of failed or changed predecessors.

Acceptance: queue more tasks than the limit, restart Hydra, and launch each eligible task once without duplicate writers. Failed prerequisites remain blocked. Each launched task records its actual starting commit and dependency artifacts. Increasing parallelism is an explicit user choice, not a token-saving claim.

### 3. Focused task briefs and useful handoffs

Status: explicit briefs, durable pre-enqueue locks, exact saved/draft previews, local user-curated handoffs and evidence references merged in PR #21 after native acceptance. Queued dependencies retain reviewed Git receipts; handoff narratives are not automatically inserted into prompts. See [Task_Context_And_Usage.md](Task_Context_And_Usage.md).

Provide editable goals, constraints, relevant paths, acceptance criteria, and test commands. Keep context inclusion explicit; do not automatically attach the entire repository, all open files, or every agent transcript. Resume related work through the provider's native session mechanism.

Completion and handoff summaries should record decisions, changed files/commits, validation, and unresolved work, with pointers to full local evidence. Pass dependency results as small, reviewed artifacts rather than replaying another agent's whole conversation. Do not create extra summarization calls merely because the user switches tasks or views.

Acceptance: the user can inspect the exact task brief and handoff, unrelated tasks receive no prior transcript automatically, and a dependent agent can locate the predecessor's verified result without redoing discovery.

### 4. Model, effort, usage, and launch budgets

Status: task/project reported-usage accounting merged in PR #21; managed Codex catalog selection, pre-turn effective acknowledgement and resumed-setting validation merged in PR #23. Both passed native acceptance. Astra High is available only when the runtime advertises the exact model/effort; actual account access is unverified. Claude effective-effort controls, soft budgets and quota information remain unfinished. See [Model_Controls.md](Model_Controls.md).

Expose per-task model and reasoning effort only through supported provider controls, and show the effective selection. Nico's preferred Astra High preset should be available when the official provider/runtime exposes that model and effort. Offer explicit choices for routine work; never silently downgrade a difficult task or substitute API-key billing for subscription authentication.

Persist reported usage with its provider semantics and aggregate it by task and project without double-counting cumulative events. Distinguish input, output, cached usage, monetary estimates, and subscription limits. Missing measurements remain unavailable. Soft budgets can warn or hold new turns and queued launches; do not promise an enforced in-flight spending cap without provider support.

Acceptance: effective settings survive resume; unsupported choices produce guidance rather than a false success; restart and repeated usage events do not inflate totals; budget warnings stop only the configured new work. UI transcript truncation or collapsing output is not recorded as model-token savings.

### 5. Real-provider workflows and repeatable setup

Status: PR #24 merged passive account setup with explicit provider-owned login/status/cancellation and no model turn on login after native acceptance. Live sign-in and realistic authenticated edit/test/approval/interruption/resume acceptance remain outstanding, along with trusted dependency setup and port/database/service allocation.

Validate realistic edit, test, approval, interruption, and resume flows for Claude Code and Codex. Complete missing permission handling before advertising those workflows as supported. Login and local setup must never submit a model turn.

Provide explicit, trusted dependency setup and resource assignments for task ports, databases, and services. Preserve diagnostics when setup fails; keep another task's setup and processes intact. This should prevent avoidable repair loops and duplicated setup work.

Acceptance: authenticated scratch tasks perform edits and tests with verified ownership and approvals; interrupted tasks resume without invented completion; parallel fixtures use distinct resources and cannot stop one another's processes. Real-provider tests must use an agreed bounded task budget.

## Efficiency and quality evidence

Compare Hydra with ordinary CLI/extension use on matching tasks, base commits, providers, models, effort settings, and acceptance tests. Repeat runs and record reported usage, completion quality, regressions, manual rework, and elapsed time. Optimize only when the comparison shows less avoidable work without a material quality drop. Correctness checks remain part of the budget.

The first release coordinates user-created tasks and explicit dependencies. Automatic task decomposition or autonomous agent swarms require a separate scope and acceptance plan. Parallel isolated agents are a core product goal; inexpensive, high-quality outcomes still require measurement.
