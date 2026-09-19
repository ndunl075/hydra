# Temporary Terra Follow-on Batch (Features 22–33)

**Status:** planning handoff. Delete this file in the final Feature 33 PR after every feature below has merged and the completion ledger has been copied into `docs/Implementation_Status.md`. Do not delete it while any feature is open. The file is intentionally temporary; its PR history remains the audit trail.

**Start condition:** Features 11–21 in `docs/Post_Feature10_Terra_Plan.md` must be merged, not merely implemented in local worktrees. At writing, Features 11, 12, and 18 are under review and unmerged. Verify `origin/main`, open PRs, worktrees, and `AGENTS.md` before starting. Do not touch the dirty root checkout or the preserved dirty `.preview/worktrees/delegation-evidence-recording` worktree.

This batch completes practical host/UI seams around the existing delegation contracts, then adds bounded local workflow and acceptance tools. It contains **12 separately reviewable features** in four waves. Parallel means independent worktrees and nonoverlapping owned paths; this environment can run at most three Terra workers beside the coordinator. A wave merges each feature individually after its own checks, then the next wave branches from the resulting `main`. Never cherry-pick an unreviewed sibling branch just to bypass a dependency.

## Shared contract for every Terra agent

1. Read `AGENTS.md`, this file, and the listed source documents before editing. Inspect current APIs and tests; the paths below are starting points, not permission to invent methods.
2. Branch from the **current merged** `origin/main` into the specified isolated worktree. Keep edits to owned paths. If a shared type or `src/extension.ts` edit is unavoidable, tell the coordinator and sequence that integration after sibling core PRs merge.
3. Implement one bounded feature. Run `npm.cmd run check`, `npm.cmd run build`, `npm.cmd test`, then the focused test shown below. Run `git diff --check`. If linked worktree dependency access blocks esbuild, rerun the same command with sandbox escalation; report the actual final result.
4. Have another agent review failure paths and negative tests. Fix review blockers before committing. Commit with `[skip ci]` only when local evidence is final. Push to `https://github.com/ndunl075/hydra.git`, open a PR, verify its full head SHA and mergeability, and merge if good. Record the PR and tested commit in `docs/Implementation_Status.md` at the final wave.
5. No live provider turns, login, API billing, signing, installer execution, deployment, automatic updates, default Auto switch, hidden scheduler, or fabricated efficiency claims. Full logs, transcripts, secrets, and raw prompts must not enter compact receipts or exports.

## Wave schedule

| Wave | Parallel features | Merge before next wave | Shared integration owner |
| --- | --- | --- | --- |
| D1 | 22, 23, 24 | All three | None; pure host/core contracts |
| D2 | 25, 26, 27 | All three | Coordinator serializes any snapshot/webview message edits |
| D3 | 28, 29, 30 | All three | Coordinator serializes journal/extension wiring |
| D4 | 31, 32, 33 | All three | Feature 33 closes status and deletes this document last |

## D1 — durable seams and local validation

### Feature 22 — explicit missing-context host ingress

- **Branch/worktree:** `feat/delegation-context-ingress` / `.preview/worktrees/delegation-context-ingress`.
- **Goal:** accept a child’s explicit Feature 02 context request only through a host-bound, user-visible ingress; bind parent/run/child, read scope, source revision and hash; persist the receipt in the Feature 07 journal. Return selected source references or a refusal without bulk transcript/history injection. No model request occurs just because a request is displayed.
- **Owned paths:** new `src/core/delegationContextIngress.ts`, `tests/delegationContextIngress.test.ts`, `docs/Delegation_Context_Ingress.md`. Shared extension command wiring is a coordinator follow-up after D1 core merges.
- **References:** `src/core/delegationContextRequests.ts`, `delegationOrchestrationJournal.ts`, `docs/Adaptive_Delegation.md` “Context supplied to a child”.
- **Acceptance:** exact binding, changed-source refusal, out-of-scope refusal, size limit, duplicate idempotence, restart replay, no full prompt/transcript, no read on simple view. Focused: `.test-build/delegationContextIngress.test.cjs`.

### Feature 23 — child result receipt host ingress

- **Branch/worktree:** `feat/delegation-result-ingress` / `.preview/worktrees/delegation-result-ingress`.
- **Goal:** turn a completed child’s concise Feature 02 result into a durable Feature 07 journal receipt only after its recorded dispatch, reviewed commit/tree, and verification evidence match. Preserve useful sibling results when another child fails. Never treat provider completion text as acceptance.
- **Owned paths:** new `src/core/delegationResultIngress.ts`, `tests/delegationResultIngress.test.ts`, `docs/Delegation_Result_Ingress.md`. Shared extension wiring waits for D1 merge.
- **References:** `src/core/delegationResults.ts`, `delegationVerification.ts`, `delegationOrchestrationJournal.ts`, `delegationWakeup.ts`, `docs/Adaptive_Delegation.md` “Results, review, and recovery”.
- **Acceptance:** exact source provenance, old-tree refusal, failed/interrupted evidence refusal, same receipt no-op, conflict refusal, journal-save failure leaves source intact, restart no duplicate delivery. Focused: `.test-build/delegationResultIngress.test.cjs`.

### Feature 24 — reproducible task setup recipe validator

- **Branch/worktree:** `feat/task-setup-recipe-validation` / `.preview/worktrees/task-setup-recipe-validation`.
- **Goal:** validate and preview a bounded, explicit setup recipe for one task’s reserved ports, service/database names, environment entries, command order and timeout. This feature only produces a reviewed recipe; existing setup execution retains ownership.
- **Owned paths:** new `src/core/setupRecipe.ts`, `tests/setupRecipe.test.ts`, `docs/Task_Setup_Recipes.md`.
- **References:** `src/core/resourceModel.ts`, `resources.ts`, `setupProcess.ts`, `docs/Task_Resources.md`.
- **Acceptance:** duplicate/conflicting resource names refuse; no secret values in preview; deterministic digest; invalid timeout/path/command refuse; no service provisioning, process start, or filesystem mutation during validation. Focused: `.test-build/setupRecipe.test.cjs`.

## D2 — focused read-only surfaces

### Feature 25 — context request inbox

- **Branch/worktree:** `feat/delegation-context-inbox` / `.preview/worktrees/delegation-context-inbox`.
- **Depends on:** 22.
- **Goal:** show pending and fulfilled context requests in the selected agent workspace with path, revision, scope and refusal reason. An explicit action may invoke Feature 22 ingress; selecting or opening the inbox only reads a snapshot.
- **Owned paths:** new focused webview component/styles and `tests/delegationContextInbox.test.ts`; minimal snapshot/message wiring after coordinator confirms no sibling edit collision.
- **References:** `src/core/focusedWorkspace.ts`, `webview/FocusedWorkspace.tsx`, `docs/Adaptive_Delegation.md` Phase 4.
- **Acceptance:** correct child/run after selection and restart, unavailable source state, keyboard/reduced-motion behavior, no source read/provider/process from navigation, explicit action guarded by current binding. Focused: `.test-build/delegationContextInbox.test.cjs` plus existing webview build/browser fixture.

### Feature 26 — result and evidence inspection

- **Branch/worktree:** `feat/delegation-result-inspection` / `.preview/worktrees/delegation-result-inspection`.
- **Depends on:** 23.
- **Goal:** show one child’s compact result, reviewed commit/tree, changed paths, verification state, unresolved issues and evidence references in its focused workspace. Clearly distinguish execution completion, verified child result, and accepted integration.
- **Owned paths:** new result webview component/styles and `tests/delegationResultInspection.test.ts`; coordinator sequences shared snapshot wiring.
- **References:** `src/core/focusedWorkspace.ts`, `delegationEvidence.ts`, `delegationResults.ts`, `docs/Agentic_Workflow_Architecture.md` Ninebrains review.
- **Acceptance:** stale/missing evidence shown as blocked, no artifact opened without an existing safe opener, no logs/transcripts copied, no model/process/check triggered by selection, multi-child identity correctness. Focused: `.test-build/delegationResultInspection.test.cjs` plus webview build/browser fixture.

### Feature 27 — setup recipe and resource preview

- **Branch/worktree:** `feat/task-setup-preview` / `.preview/worktrees/task-setup-preview`.
- **Depends on:** 24.
- **Goal:** show the validated setup recipe and current resource conflicts before the user chooses existing Run setup. Preview is read-only and labels resource names as reservations rather than provisioned services.
- **Owned paths:** new setup preview component and `tests/taskSetupPreview.test.ts`; any shared message wiring is serialized by coordinator.
- **References:** `src/core/resources.ts`, `resourceModel.ts`, `docs/Task_Resources.md`, `docs/Agent_Workflow_Roadmap.md` priority 5.
- **Acceptance:** stable digest/timeout display, conflict and missing backing service distinction, another task’s resource never released, viewing never executes commands. Focused: `.test-build/taskSetupPreview.test.cjs` plus webview build/browser fixture.

## D3 — explicit coordination and visibility

### Feature 28 — parent review decision receipt

- **Branch/worktree:** `feat/delegation-parent-review-receipt` / `.preview/worktrees/delegation-parent-review-receipt`.
- **Depends on:** 23 and 26.
- **Goal:** persist an explicit parent review decision bound to exact child result/evidence hashes before combined acceptance. Reject decisions after a result boundary or reviewed tree changes; preserve prior decisions for audit without turning a model summary into approval.
- **Owned paths:** new `src/core/delegationParentReview.ts`, `tests/delegationParentReview.test.ts`, `docs/Delegation_Parent_Review.md`; coordinator owns narrow integration gate wiring.
- **References:** `delegationResults.ts`, `delegationIntegrationGate.ts`, `docs/Adaptive_Delegation.md` results/review contract.
- **Acceptance:** exact reviewed input, duplicate no-op, conflicting/stale decision refusal, explicit rejection blocks integration, journal failure retains original evidence, restart deterministic. Focused: `.test-build/delegationParentReview.test.cjs` and integration focused test.

### Feature 29 — provenance-backed graph handoffs

- **Branch/worktree:** `feat/delegation-graph-handoff-producers` / `.preview/worktrees/delegation-graph-handoff-producers`.
- **Depends on:** 22 and 23.
- **Goal:** emit supported Feature 04 dispatch, result-delivery and approval-pause graph events only after their durable source transition. Context requests remain visible as journal receipts; the v1 graph schema has no context event kind. Reuse the Feature 07 sequence allocator, so arrows represent actual host facts rather than imagined traffic.
- **Owned paths:** new `src/core/delegationHandoffProducer.ts`, `tests/delegationHandoffProducer.test.ts`; coordinator sequences journal/extension wiring after sibling merges.
- **References:** `delegationGraphEvents.ts`, `delegationOrchestrationJournal.ts`, `delegationGraph.ts`, `docs/Adaptive_Delegation.md` visible flow.
- **Acceptance:** duplicate transition no-op, failure leaves pending source recoverable, no cross-run edge, approval pauses route, reduced motion respected by existing view, no event on mere navigation. Focused: `.test-build/delegationHandoffProducer.test.cjs` and graph focused test.

### Feature 30 — run budget and coverage view

- **Branch/worktree:** `feat/delegation-run-budget-view` / `.preview/worktrees/delegation-run-budget-view`.
- **Depends on:** 11.
- **Goal:** show parent-run reported usage, per-child contribution, pending reservation, soft hold and unavailable/partial coverage without suggesting an enforced account spend cap.
- **Owned paths:** new run budget webview component/styles and `tests/delegationRunBudgetView.test.ts`; coordinator sequences snapshot integration.
- **References:** `delegationRunAccounting.ts`, `usage.ts`, `budgets.ts`, `docs/Soft_Budgets.md`.
- **Acceptance:** cumulative event dedup appears once, unknown provider-native child usage labeled unavailable, stopped reservation disappears only after its durable release, opening view makes zero provider calls. Focused: `.test-build/delegationRunBudgetView.test.cjs` plus webview build/browser fixture.

## D4 — local evidence and usability

### Feature 31 — paired evaluation observation import

- **Branch/worktree:** `feat/delegation-evaluation-import` / `.preview/worktrees/delegation-evaluation-import`.
- **Depends on:** 12–14.
- **Goal:** import a user-supplied local observation bundle into the existing corpus/ledger after exact case, mode, base, provider/model/effort and artifact-hash checks. Persist the explicit delegated-run (12-hex) to ledger-observation (24-hex) binding and expose a read-only adapter that supplies only sealed `{ id, sha256 }` references to delegated-run export. This does not run a benchmark or a provider.
- **Owned paths:** new `src/core/delegationEvaluationImport.ts`, `tests/delegationEvaluationImport.test.ts`, `docs/Delegation_Evaluation_Import.md`; narrow read-only export adapter wiring.
- **References:** `delegationEvaluationCorpus.ts`, `delegationEvaluationLedger.ts`, `delegationEvaluationReport.ts`.
- **Acceptance:** missing measurements remain partial; duplicate exact import no-op; conflict/stale pair refused; persisted corpus/run binding survives restart; export adapter reports unavailable until an exact binding exists and never reads arbitrary files; path traversal, symlink and oversized bundle refused; no credential/prompt/raw transcript retained. Focused: `.test-build/delegationEvaluationImport.test.cjs`.

### Feature 32 — worktree archive eligibility and recovery preview

- **Branch/worktree:** `feat/task-archive-eligibility` / `.preview/worktrees/task-archive-eligibility`.
- **Depends on:** 15, 16 and 20.
- **Goal:** determine whether a task checkout can be archived after accepted integration and stopped ownership, then show a read-only recovery preview. An eligible result is advisory; this feature does not delete or move a checkout.
- **Owned paths:** new `src/core/taskArchiveEligibility.ts`, `tests/taskArchiveEligibility.test.ts`, `docs/Task_Archive_Eligibility.md`.
- **References:** `discard.ts`, `ownership.ts`, `integration.ts`, `docs/Task_Discard.md`, `docs/Agentic_Workflow_Architecture.md` integration cleanup.
- **Acceptance:** dirty/unsaved checkout, uncertain writer, unaccepted integration, pending evidence or dependent child blocks; retained branch/recovery refs listed; zero recursive deletion/move. Focused: `.test-build/taskArchiveEligibility.test.cjs`.

### Feature 33 — native workflow accessibility and completion record

- **Branch/worktree:** `feat/hydra-native-workflow-smoke` / `.preview/worktrees/hydra-native-workflow-smoke`.
- **Depends on:** 19, 25–27 and 30.
- **Goal:** add bounded native fixture assertions for Editor↔Agents mode changes, selected agent workspace, context/result inspection, budget labels, keyboard focus, high contrast and reduced motion. Produce a machine-readable local record that clearly leaves human visual/accessibility acceptance pending.
- **Owned paths:** new native smoke fixture/test files and `docs/Native_Workflow_Acceptance.md`; update `docs/Implementation_Status.md` with Features 22–33 PRs and limits. Delete **this temporary plan file** in Feature 33’s final PR only after all 12 features are merged.
- **References:** `docs/Implementation_Status.md`, `docs/Onboarding.md`, `docs/Adaptive_Delegation.md` Phase 4, existing native fixture scripts.
- **Acceptance:** no provider turn/login/install; tab selection preserves dirty editor and terminal ownership; focus labels and reduced motion survive mode changes; human/manual gate remains pending. Run check/build/full suite plus native fixture and desktop smoke commands supported by the current repo.

## Coordinator merge checklist

For every feature, record its base commit, focused/full local test result, reviewed head SHA, PR URL and merge commit. Keep shared `model.ts`, `store.ts`, `extension.ts`, `webview` message types and journal changes serialized even when pure core workers run in parallel. If a feature reveals an API mismatch, update this file on its own small documentation PR before dependent work starts. No worker should claim all twelve are done from its own passing branch.
