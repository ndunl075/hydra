# Post-Feature-10 Terra Feature Plan

## Purpose and baseline

This is the next implementation batch after the current delegation Features 08–10 have merged. It converts the remaining documented delegation and release-readiness work into bounded, independently reviewable Terra tasks. It does not claim authenticated-provider acceptance, signed distribution, manual accessibility acceptance, or measured token savings.

**Required base:** merged `main` containing Features 08, 09, and 10. Do not start a dependent wave from a merely open PR.

**Delivery rule:** every feature has its own worktree, commit, local validation, PR, and merge before its dependent wave starts. Preserve the dirty root checkout and any active feature worktree. Use `npm.cmd` on Windows.

## Product boundaries

- Auto remains opt-in. Solo remains the released default until the paired-evaluation gate passes.
- Never initiate login, an authenticated provider turn, an API-billed request, or a browser callback in these features.
- A benchmark artifact records observed evidence; it never fabricates usage, quality, provider support, or savings.
- Reconciliation and focused views are read-only until an explicit existing command is selected. Navigation must not launch work, create worktrees, submit turns, or rerun checks.
- Keep the existing scheduler, capacity, budget, worktree, session, and integration gates authoritative. New work projects their durable state rather than recreating those systems.

## Documentation discovery and allowed patterns

Read these before implementation, then copy their contracts rather than inventing APIs:

| Area | Required source | Allowed pattern |
| --- | --- | --- |
| Delegation lifecycle and benchmark gate | `docs/Adaptive_Delegation.md` — “Budgets, model choice, and visible flow”, “Verification evidence and focused agent workspace”, “Delivery and acceptance” | Persisted facts, one-level work, partial/unavailable labels, explicit release gates |
| Architecture and efficiency | `docs/Agentic_Workflow_Architecture.md` — “Parallelism without runaway spend”, “Minimal task contract”, “Implementation order and measurement” | Separate context, execution, and verification; compare matching base/provider/model/effort |
| Current delivered limits | `docs/Implementation_Status.md` — M5, M6, Planned adaptive delegation, Layout decision | Keep fixture proof distinct from live/release/manual proof |
| Scheduling and capacity | `docs/Task_Scheduling.md`, `docs/Profile_Capacity.md`, `src/core/scheduler.ts` | Reuse durable request state and profile leases; never add a second scheduler |
| Evidence and integration | `docs/Integration.md`, `src/core/delegationEvidence.ts`, `src/core/delegationOrchestrationJournal.ts` | Evidence and journal facts are immutable; required gates fail closed |
| Desktop readiness | `docs/Desktop_Delivery.md`, `docs/Windows_Installer.md`, `docs/Onboarding.md`, `docs/Settings_Import.md` | Local preflight/checklist evidence only; human/release gates remain explicit |

## Parallelism model

There are at most three Terra implementation workers beside the coordinator. Run only features with disjoint owned paths in the same wave. A worker never edits another worker’s files or the root checkout.

| Wave | Workers | Features | Start condition |
| --- | ---: | --- | --- |
| C1 | 3 | 11, 12, 18 | Features 08–10 merged |
| C2 | 3 | 13, 15, 19 | C1 merged |
| C3 | 2 | 14, 16 | C2 merged |
| C4 | 2 | 17, 20 | C3 merged |
| C5 | 1 | 21 | C4 merged |

## Feature 11: delegated-run accounting and guarded reservations

- **Branch/worktree:** `feat/delegation-run-accounting` / `.preview/worktrees/delegation-run-accounting`.
- **Goal:** add a durable parent-run usage projection that aggregates planning, child, retry, review, and validation usage without double counting cumulative provider totals. Serialize sibling launch/turn budget checks using known pending reservations. Preserve `unavailable` and `partial` coverage.
- **Owned paths:** new `src/core/delegationRunAccounting.ts`, `tests/delegationRunAccounting.test.ts`; narrow model/store/extension snapshot wiring.
- **Copy from:** existing usage aggregation in `src/core/usage.ts`, soft holds in `src/core/budgets.ts`, and Feature 08/09 durable run records.
- **Must prove:** idempotent repeated provider events; resume does not inflate totals; parent and child usage remain distinct; unknown coverage is never zero; one sibling’s reservation blocks a conflicting sibling without blocking a completed receipt view; cancellation releases only its own pending reservation.
- **Do not:** estimate a monetary cost, call a provider, mutate a session, or make a strict in-flight spend claim.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationRunAccounting.test.cjs`.

## Feature 12: versioned Auto-versus-Solo evaluation corpus

- **Branch/worktree:** `feat/delegation-evaluation-corpus` / `.preview/worktrees/delegation-evaluation-corpus`.
- **Goal:** define and validate a local, versioned paired-run corpus manifest. Each case pins repository/base, provider/model/effort, acceptance commands, declared quality threshold, budget ceiling, and required observations.
- **Owned paths:** new `src/core/delegationEvaluationCorpus.ts`, `tests/delegationEvaluationCorpus.test.ts`, `docs/Delegation_Evaluation_Protocol.md`, fixture corpus under `tests/fixtures/delegation-evaluation/`.
- **Must prove:** exact schema/version rejection; duplicate/mutable case refusal; Auto/Solo pair equivalence; no credential/prompt transcript storage; explicit sample/tolerance fields; corpus verification is read-only.
- **Do not:** run the corpus, submit model turns, select Auto as default, or infer a pass from missing usage.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationEvaluationCorpus.test.cjs`.

## Feature 18: desktop release-evidence preflight

- **Branch/worktree:** `feat/desktop-release-evidence-preflight` / `.preview/worktrees/desktop-release-evidence-preflight`.
- **Goal:** produce a local, read-only manifest checker for installer provenance, runtime hashes, chosen shortcut behavior, prior-version baseline, and outstanding manual/release gates.
- **Owned paths:** new `scripts/verify-release-evidence.ps1`, `tests/releaseEvidencePreflight.test.ts`, `docs/Release_Evidence_Protocol.md`.
- **Must prove:** incomplete/signing-missing/manual-pending evidence stays blocked; selected/unselected shortcut claims bind to artifact hashes; no installer, registry, shortcut, or user-data mutation occurs.
- **Do not:** sign, distribute, install, uninstall, update, or claim a disposable Windows run happened.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; focused Node test plus `powershell -File scripts/verify-release-evidence.ps1 -WhatIf`.

## Feature 13: paired-run evidence ledger and aggregation

- **Branch/worktree:** `feat/delegation-evaluation-ledger` / `.preview/worktrees/delegation-evaluation-ledger`.
- **Depends on:** 11 and 12.
- **Goal:** persist immutable local observations from explicitly supplied run evidence, bind them to a corpus pair, and project quality, elapsed time, usage coverage, regressions, conflicts, and manual rework without interpreting missing evidence as success.
- **Owned paths:** new `src/core/delegationEvaluationLedger.ts`, `tests/delegationEvaluationLedger.test.ts`; minimal model/store snapshot changes.
- **Must prove:** exact pair/base/settings binding; duplicate exact evidence no-op; conflicting evidence fails closed; partial usage remains partial; evidence artifacts retain hashes/references rather than logs/transcripts; detached restart replay is deterministic.
- **Do not:** collect live provider data, open an external artifact, recalculate provider usage, or choose a rollout decision.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationEvaluationLedger.test.cjs`.

## Feature 15: delegated-run reconciliation workspace

- **Branch/worktree:** `feat/delegation-reconciliation-workspace` / `.preview/worktrees/delegation-reconciliation-workspace`.
- **Depends on:** Features 08–11.
- **Goal:** add a read-only focused reconciliation projection for pending dispatches, uncertain writers, cancelled siblings, journal recovery markers, budget holds, and restart status. Existing explicit reconcile commands stay the only mutation paths.
- **Owned paths:** new `src/core/delegationReconciliation.ts`, `tests/delegationReconciliation.test.ts`, focused webview component/style files, narrow extension snapshot wiring.
- **Must prove:** correct selected parent/run/child identity across restart; missing data is unavailable; clicking/selecting does not launch, stop, reconcile, or create a process; reduced-motion and dark/light states remain usable.
- **Do not:** add a hidden retry, scheduler drain, provider turn, worktree creation, or “fix all” command.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; focused core test and existing webview/browser fixture command.

## Feature 19: native/manual acceptance artifact kit

- **Branch/worktree:** `feat/native-acceptance-artifacts` / `.preview/worktrees/native-acceptance-artifacts`.
- **Depends on:** Feature 18.
- **Goal:** ship reusable, non-mutating acceptance checklists and artifact schemas for onboarding, appearance/settings import, focused workspace navigation, installer wizard, and integration/discard flows.
- **Owned paths:** `docs/Native_Acceptance_Kit.md`, new validation schema/parser and focused tests.
- **Must prove:** all manual gates are clearly marked pending until an operator attaches a valid artifact; artifact schema rejects screenshots/logs without provenance; no click automation triggers account login, installer execution, or provider work.
- **Do not:** convert manual acceptance into a false automated pass.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; focused artifact-schema test.

## Feature 14: Auto-versus-Solo decision report

- **Branch/worktree:** `feat/delegation-evaluation-report` / `.preview/worktrees/delegation-evaluation-report`.
- **Depends on:** 11–13.
- **Goal:** render a durable decision report from the corpus and ledger. It compares only matching pairs and returns `insufficient`, `keep-solo`, or `eligible-for-human-rollout-review`; it never flips the preference itself.
- **Owned paths:** new `src/core/delegationEvaluationReport.ts`, `tests/delegationEvaluationReport.test.ts`, read-only webview projection.
- **Must prove:** predeclared tolerances/sample count are required; quality regression always blocks; faster-but-more-expensive is reported as a tradeoff; unknown usage blocks a token-efficiency conclusion; results are deterministic after restart.
- **Do not:** enable Auto by default, make an authenticated call, or represent a model prediction as observed savings.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationEvaluationReport.test.cjs`.

## Feature 16: result-boundary archive record

- **Branch/worktree:** `feat/delegation-result-boundary-archive` / `.preview/worktrees/delegation-result-boundary-archive`.
- **Depends on:** Features 10 and 13.
- **Goal:** preserve a reviewed child-result/evidence boundary when a later reviewed commit/tree differs, instead of overwriting old facts or accepting stale evidence.
- **Owned paths:** new `src/core/delegationResultBoundary.ts`, `tests/delegationResultBoundary.test.ts`; narrow evidence/journal/model integration.
- **Must prove:** changed tree requires a new explicit boundary; prior evidence stays immutable and inspectable; duplicate exact boundary no-ops; conflicting identities fail; combined acceptance still requires current evidence.
- **Do not:** silently migrate an evidence pass to a changed tree or auto-integrate a child.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; focused boundary and integration tests.

## Feature 17: external-provider readiness preflight

- **Branch/worktree:** `feat/provider-readiness-preflight` / `.preview/worktrees/provider-readiness-preflight`.
- **Depends on:** Feature 19.
- **Goal:** add a passive, local readiness report for documented live-acceptance prerequisites: installed adapter version, selected supported controls, bounded task/evidence template, and explicit authorization requirement.
- **Owned paths:** new `src/core/providerReadiness.ts`, `tests/providerReadiness.test.ts`, `docs/Provider_Live_Acceptance_Protocol.md`.
- **Must prove:** no account identity/token/callback is persisted; unsupported/unknown capabilities are unavailable; readiness does not launch a login, process, or turn; report includes the user-approved budget/operator fields as missing until supplied.
- **Do not:** invoke provider auth, use API billing, scrape accounts, or claim subscription eligibility.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/providerReadiness.test.cjs`.

## Feature 20: delegated run archive and recovery export

- **Branch/worktree:** `feat/delegation-run-export` / `.preview/worktrees/delegation-run-export`.
- **Depends on:** Features 13, 15, and 16.
- **Goal:** create a bounded local export/archive of durable run facts, evaluation evidence references, boundaries, and recovery state for review. It must never include full prompts, transcripts, credentials, or raw logs.
- **Owned paths:** new `src/core/delegationRunExport.ts`, `tests/delegationRunExport.test.ts`, read-only export UI/command wiring.
- **Must prove:** stable schema/hash; redaction by construction; corrupted/oversized archives refuse; import is not supported; export navigation has zero process/provider side effects.
- **Do not:** export task source wholesale, upload data, or imply cross-device synchronization.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationRunExport.test.cjs`.

## Feature 21: human rollout-review gate

- **Branch/worktree:** `feat/delegation-rollout-review-gate` / `.preview/worktrees/delegation-rollout-review-gate`.
- **Depends on:** Features 14, 17, and 20.
- **Goal:** present an immutable local review packet that binds the evaluation report, readiness state, required manual artifacts, release provenance, and an explicit human decision. It can recommend a review but cannot enable Auto.
- **Owned paths:** new `src/core/delegationRolloutReview.ts`, `tests/delegationRolloutReview.test.ts`, `docs/Delegation_Rollout_Review.md`.
- **Must prove:** missing external evidence blocks approval; stale report/artifact hashes block approval; approval records operator/date/rationale but does not mutate provider settings; restart preserves the packet exactly.
- **Do not:** change global Auto/Solo preference, publish a release, send telemetry, or execute a benchmark/live task.
- **Commands:** `npm.cmd run check`; `npm.cmd run build`; `npm.cmd test`; `node --test .test-build/delegationRolloutReview.test.cjs`.

## Wave review gates

After every wave: use fresh worktrees from merged `main`, run each feature’s focused test plus check/build, inspect overlapping model/store/extension changes, and use Sol for Features 11, 13, 15, 16, and 21 before merging. Do not rely on GitHub Actions when equivalent local evidence is available.

## External gates deliberately outside Terra implementation

The following need Nico’s later, explicit authorization and cannot be marked complete by this plan: authenticated provider sign-in/turns and subscription-plan acceptance; API or paid usage; choosing the benchmark corpus, sample size, quality threshold, and budget; a disposable distinct-version Windows installer run; signing/distribution/updates; and human accessibility/wizard acceptance.

