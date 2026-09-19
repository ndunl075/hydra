# Terra parallel feature execution plan

Status: execution plan only. Baseline: `origin/main` at `422af69` (PR #58). No feature in this document is claimed complete.

This plan scopes the next ten Hydra features for GPT Terra. Each feature uses its own branch and Git worktree, produces one locally verified pull request, and merges only after its dependencies are on `main`.

## Can all ten run at once?

Ten isolated worktrees can exist at once. Ten writers should not run at once. Even if ten external Terra sessions are available, these ten roadmap features have a safe peak width of three because features 03 and 07–10 are dependency-ordered and share host contracts.

The current agent environment exposes four total agent slots, including the coordinator, so one execution session can run at most three Terra workers concurrently. More importantly, worktrees isolate checkouts but do not prevent semantic conflicts in shared contracts. These files are integration choke points and must have one owner at a time:

- `src/core/model.ts`
- `src/core/store.ts`
- `src/extension.ts`
- `src/core/scheduler.ts`
- `webview/index.tsx`
- shared webview message types

Use the waves below. Wave A deliberately keeps most work in new modules and focused tests. Later waves wire those contracts into the shared host in dependency order. Do not raise Hydra's two-active-managed-task product default merely because development has multiple worktrees.

## Phase 0: documentation discovery and coordinator preflight

Before launching workers:

1. Fetch `origin/main` and record one immutable `BASE_SHA` for the wave.
2. Confirm no feature listed below has already merged since `422af69`.
3. Create the named branch and worktree from that exact base.
4. Give each Terra worker only its feature brief, relevant documentation, allowed paths, forbidden paths, and acceptance commands.
5. Keep `src/core/model.ts`, `src/core/store.ts`, `src/extension.ts`, and `src/core/scheduler.ts` under coordinator ownership unless the feature explicitly owns one.
6. After each merge, rebase or recreate dependent worktrees from the new `origin/main`. Never resolve shared-schema conflicts independently in multiple branches.
7. Run tests locally and use `[skip ci]` when the local release gate passes. Do not use live provider turns, API-key billing, or authenticated account tests unless Nico explicitly authorizes that later.
8. Give each worker a feature-specific document. Only the coordinator edits `docs/Adaptive_Delegation.md`, `docs/Agent_Workflow_Roadmap.md`, or `docs/Implementation_Status.md`.
9. Three implementation workers consume every non-coordinator slot. Release those workers before spawning fresh verification and review agents.

Allowed existing APIs and patterns:

- Delegation policy and validation: `hostDelegationPolicy(proposalValue, policyValue, parent, preferences)` in `src/core/delegationHost.ts` and `prepareDelegation(value, policy, usedKeys = [])` in `src/core/delegationPlan.ts`.
- Focused context: `buildChildContext()` and `assertFreshContext()` in `src/core/delegationContext.ts`.
- Child lifecycle: `createDelegatedChildren()`, `enrollDelegatedChildren()`, and `cancelDelegatedEnrollment()` in `src/core/delegationChildren.ts`.
- Evidence: `validateDelegatedVerificationEvidence()` and `assertDelegatedVerificationGate()` in `src/core/delegationEvidence.ts`.
- Scheduler: `TaskScheduler.enqueue()`, `drain()`, and `reconcile()` in `src/core/scheduler.ts`.
- Durable storage: `LocalStore.load(): Promise<Task[]>` and `LocalStore.save(tasks): Promise<void>` in `src/core/store.ts`. Store serialization does not replace an in-memory Manager transaction boundary.
- UI projections: `focusedWorkspace()` in `src/core/focusedWorkspace.ts` and `delegationGraph()` in `src/core/delegationGraph.ts`.
- Integration: the candidate lifecycle in `src/core/integration.ts`, which already invokes the delegated evidence gate.

No supported evidence-artifact opener exists on this baseline. UI features may show safe read-only artifact metadata; a future allowlisted opener requires its own host contract and review.

Global anti-pattern guards:

- Do not invent a provider-native subagent API. Managed children use separate supported provider sessions.
- Do not copy the parent transcript, entire repository, all open files, or sibling histories into a child brief.
- Do not treat provider completion as verified or integrated completion.
- Do not mark missing, unavailable, interrupted, or stale evidence as passed.
- Do not launch a process or model turn when opening the graph, focused workspace, evidence, or settings.
- Do not silently change provider, model, or effort, and do not substitute API billing for subscription authentication.
- Do not treat a worktree as a process, port, secret, database, or filesystem sandbox.

## Execution waves

| Wave | Parallel Terra workers | Features | Start condition |
| --- | ---: | --- | --- |
| A1 | 3 | 01, 02, 04 | Phase 0 complete; fixed base SHA |
| A2 | 3 | 03, 05, 06 | A1 features merged; recreate all three worktrees from new main |
| B1 | 1 | 07 | Features 02–04 merged |
| B2 | 1 | 08 | Feature 07 merged; recreate from new main |
| B3 | 1 | 09 | Feature 08 merged; recreate from new main |
| B4 | 1 | 10 | Features 01, 02, and 07–09 merged |

This schedule uses all three available worker slots in A1/A2 while keeping shared integration changes serialized. It is faster than ten conflicting branches because dependent workers start from merged contracts instead of independently guessing them.

## Feature 01: finish durable verification recording

- Branch/worktree: `feat/delegation-evidence-recording-v2` / `.preview/worktrees/delegation-evidence-recording-v2`.
- Goal: execute explicit Hydra-owned validation commands for a reviewed delegated child, retain full local logs, and persist exact attempt evidence without claiming unavailable or interrupted checks passed.
- Current state: an uncommitted `feat/delegation-evidence-recording` worktree exists on the older `fda02a1` base. Preserve it intact. Create the `-v2` branch from current `main`, then port only reviewed changes.
- Preservation rule: treat the existing worktree as read-only patch evidence. Do not edit, clean, rebase, delete, prune, or reuse it. Only the new `-v2` worktree may be pruned after its PR merges.
- Required fixes before merge: separate durable save from publish/capacity work; fence shutdown during save; downgrade only the latest interrupted attempt; preserve earlier attempt history; restore UTF-8 punctuation in `docs/Adaptive_Delegation.md`.
- Owned paths: `src/core/delegationVerification.ts`, `src/core/delegationVerificationTransaction.ts`, `tests/delegationVerification.test.ts`; minimal reviewed wiring in `src/extension.ts`.
- Forbidden: evidence UI, provider turns, changes to scheduler capacity.
- References: `docs/Adaptive_Delegation.md` section “Verification evidence and focused agent workspace”; `src/core/delegationEvidence.ts`; process launch/termination helpers in `src/core/process.ts`.
- Acceptance: type check, build, full suite, focused tests for log-write failure, Windows `.cmd`, pre-abort, descendant termination, retry preflight, failed persistence rollback, abort-during-save, shutdown reload, and immutable prior attempts.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationVerification.test.cjs`.

## Feature 02: focused context exchange and child result contracts

- Branch/worktree: `feat/delegation-exchange-contracts` / `.preview/worktrees/delegation-exchange-contracts`.
- Goal: define pure, versioned contracts for a child to request specific missing context and return a concise result receipt. Persistence and delivery are intentionally assigned to feature 07.
- Dependencies: none beyond the Phase 0 base.
- Owned paths: new `src/core/delegationContextRequests.ts`, new `src/core/delegationResults.ts`, new `tests/delegationContextRequests.test.ts`, new `tests/delegationResults.test.ts`, and `docs/Delegation_Exchange_Contracts.md`.
- Forbidden in this wave: `src/extension.ts`, `src/core/model.ts`, provider launch, transcript copying, automatic scope expansion.
- References: `buildChildContext()` and `assertFreshContext()` in `src/core/delegationContext.ts`; `src/core/delegationDispatch.ts`; `src/core/delegationStore.ts`; “Context supplied to a child” and “Results, review, and recovery” in `docs/Adaptive_Delegation.md`.
- Acceptance: path/scope validation, stale-revision rejection, SHA-256 provenance, size bounds, deduplication, exact commit/tree result identity, evidence references instead of copied logs, dependency binding, malformed/cross-run rejection, JSON round trip, and proof that unrelated history is absent.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationContextRequests.test.cjs .test-build/delegationResults.test.cjs`.

## Feature 03: normal-turn planner proposal ingestion

- Branch/worktree: `feat/delegation-planner-ingestion` / `.preview/worktrees/delegation-planner-ingestion`.
- Goal: ingest a structured Solo/delegate proposal from the parent’s normal managed turn, reuse the existing validators, and durably record the decision without a separate planner turn or child launch.
- Dependencies: feature 02 merged only for shared result terminology; the proposal parser itself already exists.
- Owned paths: new `src/core/delegationPlannerIngestion.ts`, new `tests/delegationPlannerIngestion.test.ts`, `docs/Delegation_Planner_Ingestion.md`; this feature owns the minimal coordinated `src/core/model.ts`, `src/core/store.ts`, and `src/extension.ts` wiring for Wave A2.
- Forbidden: reimplementing `parseDelegationProposal()`, `prepareDelegation()`, or `hostDelegationPolicy()`; provider launch; worktree creation; recursive children; hidden reasoning storage.
- References: `parseDelegationProposal()` and `prepareDelegation()` in `src/core/delegationPlan.ts`; `hostDelegationPolicy()` in `src/core/delegationHost.ts`; the existing normal-turn completion event path in `src/extension.ts`.
- Acceptance: normal provider output can record Solo or an eligible proposal; malformed/cyclic/overlapping/bad-base/unsupported proposals fail through existing validators; duplicate turn events are idempotent; restart preserves one decision; no extra model call occurs; no child is materialized or launched.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationPlannerIngestion.test.cjs`.
- Review model: Terra implements; Sol performs a pre-implementation contract review and final transaction/provider-boundary review.

## Feature 04: delegation event contract

- Branch/worktree: `feat/delegation-event-provenance` / `.preview/worktrees/delegation-event-provenance`.
- Goal: define a pure, versioned event contract for assignment, dispatch, result delivery, validation, approval pause, interruption, and acceptance, with stable IDs and replay order. Persistence and producers are assigned to feature 07.
- Dependencies: consume existing delegation/task identities; do not require managed execution yet.
- Owned paths: new `src/core/delegationGraphEvents.ts`, new `tests/delegationGraphEvents.test.ts`, and `docs/Delegation_Event_Contract.md`.
- Forbidden in this wave: `src/extension.ts`, `src/core/model.ts`, `webview/index.tsx`, animation changes.
- References: `delegationGraph()` and `tests/delegationGraph.test.ts`; graph requirements in `docs/Adaptive_Delegation.md`.
- Acceptance: deterministic ordering, duplicate suppression, explicit provenance, schema migration/refusal rules, no inferred traffic, and a bounded-history policy that feature 07 can persist.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationGraphEvents.test.cjs`.

## Feature 05: focused workspace attempt details

- Branch/worktree: `feat/focused-workspace-evidence-details` / `.preview/worktrees/focused-workspace-evidence-details`.
- Goal: extend the existing focused workspace from evidence counts to per-attempt check details, artifact metadata, timestamps, and retry history. Show only preview metadata that already has an authoritative source.
- Dependencies: existing PR #51–#58 foundations and the merged evidence schema. It does not depend on feature 01’s runner internals.
- Owned paths: `src/core/focusedWorkspace.ts`, `webview/FocusedWorkspace.tsx`, `webview/styles.css`, `tests/focusedWorkspace.test.ts`.
- Forbidden: `src/extension.ts`, `src/core/model.ts`, process launch, model turns, automatic preview startup.
- References: current focused workspace implementation and “Verification evidence and focused agent workspace” in `docs/Adaptive_Delegation.md`.
- Acceptance: correct attempt/check/artifact/retry projection, explicit missing/unavailable/interrupted states, read-only artifact kind/label/path metadata, light/dark/reduced-motion/narrow layouts, multiple-agent selection, restart projection, and zero process/model requests from navigation. Artifact opening is deferred because no supported opener exists.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/focusedWorkspace.test.cjs`.

## Feature 06: event-backed graph handoff animation

- Branch/worktree: `feat/delegation-event-graph` / `.preview/worktrees/delegation-event-graph`.
- Goal: render assignment and result-handoff movement from persisted feature-04 events, with explicit provenance and lifecycle labels. Until feature 07 supplies persisted events, use immutable fixtures only.
- Dependencies: feature 04 merged.
- Owned paths: `src/core/delegationGraph.ts`, `webview/AgentMap.tsx`, `webview/agent-map.css`, `tests/delegationGraph.test.ts`, and new fixtures under `tests/fixtures/delegation-event-graph/`.
- Forbidden: `src/extension.ts`, `src/core/model.ts`, event persistence, inferred agent-to-agent traffic, model/process launch.
- References: current `delegationGraph()`, `AgentMap.tsx`, existing provider-colored paths and reduced-motion rules.
- Acceptance: only recorded event edges animate; approvals pause the affected route; stale/completed events stop; duplicate events do not duplicate motion; reduced motion disables animation; navigation produces zero side effects.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationGraph.test.cjs`.

## Feature 07: durable orchestration journal and delivery

- Branch/worktree: `feat/delegation-orchestration-journal` / `.preview/worktrees/delegation-orchestration-journal`.
- Goal: persist feature-02 context exchanges/results and feature-04 graph events, produce them from existing host transitions, replay them after restart, and expose read-only snapshot projections to features 05/06.
- Dependencies: features 02–04 merged. Recreate from current `main`.
- Owned paths: new `src/core/delegationOrchestrationJournal.ts`, new `tests/delegationOrchestrationJournal.test.ts`; this feature owns coordinated changes to `src/core/model.ts`, `src/core/store.ts`, `src/extension.ts`, and snapshot/webview message types for this wave.
- Forbidden: managed child launch, parent wakeup/model submission, graph selection side effects, full transcript persistence.
- References: `LocalStore.load()/save()`, existing delegation receipts, Manager persistence transaction patterns, and the merged pure contracts.
- Acceptance: atomic append/deduplication, schema validation and safe legacy load, bounded event history, exact context/result provenance, restart replay, event production at real host transitions, snapshot projection without model calls, and failed persistence leaving live task state unchanged.
- Internal stage A: implement the pure journal schema, validation, storage migration, and restart fixtures. Do not begin host wiring until these focused tests pass.
- Internal stage B: add host event producers and snapshot wiring, then rerun persistence-failure, restart, and duplicate-event gates.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationOrchestrationJournal.test.cjs`.
- Review model: Terra implements each internal stage; Sol performs a pre-implementation persistence contract review and final host/concurrency review.

## Feature 08: managed child dispatch through the scheduler

- Branch/worktree: `feat/delegation-managed-dispatch` / `.preview/worktrees/delegation-managed-dispatch`.
- Goal: enqueue explicitly approved enrolled children through the existing shared scheduler, resource, profile-capacity, and budget gates. Persist a dispatch reservation before process/session creation, then persist the provider session ID as soon as the supported adapter reports it.
- Dependencies: feature 07 merged. Recreate the worktree from its merged `main`.
- Owned paths: new `src/core/delegationRunner.ts`, `tests/delegationRunner.test.ts`; this feature owns coordinated edits to `src/core/scheduler.ts`, `src/core/model.ts`, and `src/extension.ts` for this wave.
- Forbidden: parent wakeup/synthesis, automatic planner turns, recursive Hydra grandchildren, hidden model/provider changes.
- References: `TaskScheduler.enqueue()/drain()/reconcile()`, `ManagedSessions`, child enrollment helpers, resource and profile-capacity tests.
- Acceptance: persist a dispatch reservation before process/session creation; persist the provider session ID as soon as the supported adapter reports it; exact-once eligible launch; two-slot capacity including the parent; task/project budget holds; selected base/worktree/provider/model/effort preservation; restart reconciliation; duplicate-writer refusal; dependency blocking; and stop before/after launch.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationRunner.test.cjs .test-build/scheduler.test.cjs`.
- Review model: Terra implements; Sol performs a pre-implementation transition/ownership review and final scheduler, provider-process, transaction, and restart review.

## Feature 09: parent suspension, result delivery, and bounded retry

- Branch/worktree: `feat/delegation-parent-wakeup` / `.preview/worktrees/delegation-parent-wakeup`.
- Goal: persist a parent waiting state, release its active scheduler slot without destroying its provider session, deliver durable child results, coalesce simultaneous completions, deduplicate wakeups across restart, and enforce one retry per child/run.
- Dependencies: feature 08 merged.
- Owned paths: new `src/core/delegationWakeup.ts`, new `tests/delegationWakeup.test.ts`; coordinated host/model/scheduler edits after feature 07.
- Forbidden: integration promotion, recursive children, idle polling/model heartbeats, retry counter reset by replanning.
- References: result receipts from feature 02, orchestration journal from feature 07, scheduler/session resume patterns, “Results, review, and recovery” in `docs/Adaptive_Delegation.md`.
- Acceptance: documented waiting-state transition table; main slot release without session loss; simultaneous completion coalescing; one durable wakeup; failed prerequisite blocking; useful sibling completion retention; restart before/after delivery; cancellation preventing new wakeups; and one-retry lifetime enforcement.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationWakeup.test.cjs .test-build/scheduler.test.cjs`.
- Review model: Terra implements; Sol performs a pre-implementation suspension/resume review and final scheduler/session/persistence review.

## Feature 10: combined delegated acceptance orchestration

- Branch/worktree: `feat/delegation-combined-acceptance` / `.preview/worktrees/delegation-combined-acceptance`.
- Goal: require parent review plus combined acceptance after child evidence succeeds; preserve candidates and tasks on conflict, stale input, cancellation, or failed checks.
- Dependencies: features 01, 02, and 07–09 merged.
- Owned paths: new `src/core/delegationIntegrationGate.ts`, focused changes to `src/core/integration.ts`, `tests/integration.test.ts`, and fixtures under `tests/fixtures/delegation-combined-acceptance/`.
- Forbidden: weakening existing target cleanliness/stale-review checks, treating a child’s pass as combined acceptance, automatic conflict resolution.
- References: `assertDelegatedVerificationGate()`, integration candidate lifecycle, `docs/Integration.md`, Phase 3 delivery gate in `docs/Adaptive_Delegation.md`.
- Acceptance: missing/stale/failed/interrupted child evidence blocks before promotion, passing children can still fail combined acceptance, failed prerequisites block, conflict work remains recoverable, target changes force revalidation, and successful promotion matches the reviewed candidate exactly.
- Commands: `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/integration.test.cjs`.

## Terra handoff template

Use this template for each worker. Replace every bracketed value before launch.

```text
You are implementing Hydra feature [NN: name] in isolated worktree [absolute path] on branch [branch].

Base SHA: [immutable SHA]
Dependencies already merged: [SHAs]
Goal: [one observable outcome]
Allowed write scope: [paths]
Forbidden paths: [paths]
Documentation to read first: [specific files/sections]
Existing APIs/patterns to copy: [exact symbols/files]
Acceptance commands: [commands]
Required fixtures: [cases]

Do not invent APIs, broaden scope, launch providers, use API-key billing, or edit shared choke-point files outside the allowed scope. Preserve complete local evidence. Stop and report a concrete blocker if the documented interface is absent. Do not commit until independent verification and review pass.
```

## Merge and verification policy

For every feature:

1. Implementation agent edits only the allowed worktree and paths.
2. Fresh verification agent runs `npm.cmd run check`, then `npm.cmd run build`, then `npm.cmd test`. The full test command creates fresh compiled output; only after it passes, rerun the feature-focused `.test-build` files named in that feature's command list. Never use a pre-existing `.test-build` artifact.
3. Fresh anti-pattern review checks forbidden paths, invented APIs, provider/model substitution, missing-runner pass behavior, and navigation side effects.
4. Fresh quality review checks concurrency, durable persistence, restart recovery, and test relevance.
5. Commit with `[skip ci]` only after local approval, push, open one PR, verify the exact head SHA, merge if good, and prune the merged branch/worktree.
6. Recreate dependent worktrees from the new `origin/main`; do not merge a stack of stale shared-host branches.

## Completion boundary

Completing these ten features would establish the fixture-tested adaptive-delegation execution, result-delivery, evidence, and combined-acceptance path. It would not complete parent-run accounting, the Auto-versus-Solo evaluation harness, signed distribution, live account/provider acceptance, manual accessibility, automatic updates, or prove token savings. Those remain later architecture and release gates and require separate authorization where real subscription accounts or external effects are involved.
