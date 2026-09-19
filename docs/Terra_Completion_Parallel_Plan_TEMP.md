# Terra completion plan: parallel Hydra worktrees

Status: execution plan, not an implementation or release claim. Baseline: `f5213f84c50c6de38d7fdd5a3c64ca017a885155` (merged PR #103). This file is temporary so Terra agents can read the same contract; remove it in the final completion-record PR after the work below has merged. The main checkout has unrelated edits to `tests/delegation.test.ts` and `image.png`; do not edit or clean it.

Nico's remaining product goal is automatic, cost-conscious solo-or-child delegation through isolated worktrees, with real provider acceptance and a distributable Windows IDE. The existing host already has many durable pieces. A passing fixture, a connected-looking account panel, or a generated unsigned installer is not proof of the complete product. Keep Solo as the default until paired quality and efficiency evidence permits an Auto rollout.

## Phase 0 — read the actual contracts before coding

Every Terra agent first reads `AGENTS.md`, this plan, and its named references from the current `origin/main`. Search signatures again after rebasing; do not infer an API from this table alone. These are the allowed existing seams, not instructions to replace their invariants:

| Existing seam | Current source and use | Guard |
| --- | --- | --- |
| Proposal and policy | `src/core/delegationPlan.ts`: `prepareDelegation(value, policy, usedKeys?)`, `parseDelegationPolicy`; `src/core/delegationHost.ts`: `hostDelegationPolicy(...)`; `src/core/delegationPreferences.ts`: `parseDelegationPreferences(...)` | The model proposes; the host validates. One level, approved base/scope/provider/model/effort, child cap, and cycle checks stay intact. |
| Parent planning | `src/core/delegationPlannerIngestion.ts`: `createDelegationPlannerRun`, `plannerPromptSuffix`, `bindDelegationPlannerTurn`, `ingestDelegationPlannerCompletion`; `src/core/delegationStore.ts`: durable decisions | Existing planner ingestion is tied to the normal parent turn. Opening a view must not submit another planner turn. |
| Brief and dispatch | `src/core/delegationContext.ts`: `buildChildContext`, `assertFreshContext`; `src/core/delegationDispatch.ts`: `DelegationDispatchStore.materialize`; `src/core/delegationChildren.ts`: `createDelegatedChildren`, `enrollDelegatedChildren` | Preserve mandatory constraints within the 32,000-character brief limit. A worktree is not a filesystem sandbox. |
| Queue, capacity, and budgets | `src/core/scheduler.ts`: `TaskScheduler.enqueue`, `configureSchedule`; `src/core/profileCapacity.ts`; `src/core/delegationRunAccounting.ts`: `reserveDelegationBudget`, `releaseDelegationBudget`, `projectDelegationRunUsage` | Persist reservation before launch, count the parent, and leave unknown usage unavailable. Never auto-reclaim an uncertain writer. |
| Wakeup, results, integration | `src/core/delegationWakeup.ts`: `DelegationWakeup`; `src/core/delegationResults.ts`: `prepareDelegationResult`; `src/core/delegationIntegrationGate.ts`: `delegationIntegrationGate`; `src/core/integration.ts`: `Integrations.prepare`, `promote`, `recover` | Completion text is not accepted integration. Require saved evidence, current parent review, and combined checks. |
| Provider-owned sessions and accounts | `src/core/managedSessions.ts`: `ManagedSessions`; `src/core/accountSetup.ts`: `CodexAccountFlow`, `publicClaudeAccount`, `accountRpc`; `src/core/quota.ts`: `readCodexQuota`, `publicCodexQuota` | Use only supported pinned CLI/App Server protocols. No credential reads, transcript export, API-key billing substitution, or silent model changes. |
| Desktop and acceptance | `scripts/desktop.mjs`: `prepare`, `build`, `verify`, `smoke`, `installer`; `scripts/desktop-upgrade-test.ps1`; `desktop/upgrade-baseline.json`; `docs/Native_Workflow_Acceptance.md` | Installer upgrade runs only in a disposable Windows host. Signing keys, distribution, real accounts, and human visual review are external gates. |

Read `docs/Adaptive_Delegation.md`, `docs/Agent_Workflow_Roadmap.md`, `docs/Implementation_Status.md`, `docs/Desktop_Delivery.md`, and the relevant focused docs for the assigned task. Copy the established validation, atomic-save, and refusal patterns from these sources. Do not invent provider RPCs, VS Code commands, installer flags, or update endpoints. Documentation discovery is complete only when the agent names the exact signatures and a nearby test pattern in its PR description.

## How to run the batch

1. Merge this plan first. Give every feature below its own branch and `.preview/worktrees/<slug>` worktree from that merged main. Wave A agents own only the paths listed for their task. They may read all files but must not edit `src/extension.ts`, `src/core/model.ts`, `src/core/store.ts`, `webview/index.tsx`, package manifests, or shared workflow files. They must not import another Wave A module before that module merges. This freezes a usable interface for simultaneous work.
2. Start all ready Wave A tasks concurrently if the executor has enough slots. On this agent runtime, only the available concurrency slots can actually execute at once; queue the rest without changing the dependency graph. Full native smoke, installer work, and the full test suite must be serialized on one machine to avoid shared host/profile contention. Focused tests, typechecks, and builds can run in the isolated worktrees.
3. Each Terra agent makes one bounded feature commit and submits its branch/PR. A coordinator checks scope, tests, and exact reviewed head, then merges one PR at a time. Rebase remaining branches on merged main and repeat relevant checks if a dependency or shared contract changed. Use local `npm.cmd run check`, `npm.cmd run build`, focused tests, and full `npm.cmd test` when the feature affects a cross-module path. Prefer local checks to GitHub Actions; the disposable Windows installer gate is the explicit exception.
4. No worker edits another worker's checkout, force-pushes a reviewed head, marks a live gate passed from fixture evidence, or deletes a worktree with uncommitted changes. The coordinator records base SHA, test result, reviewed head, PR URL, and merge SHA in `docs/Implementation_Status.md` as the waves land. Keep root's existing dirty files untouched.

## Wave A — 13 independent Terra worktrees

All thirteen tasks can begin from the plan merge. Each task has new, exclusive paths, a behavioral acceptance test, and no dependency on another new module. Where an exact name/signature differs on current main, the agent reports the mismatch before coding and keeps its exported interface small. Do not attach these modules to shared host/UI files in Wave A.

### A1. Auto admission decision

- Branch/worktree: `feat/auto-delegation-admission` / `.preview/worktrees/auto-delegation-admission`.
- Own: new `src/core/autoDelegationAdmission.ts`, `tests/autoDelegationAdmission.test.ts`, `docs/Auto_Delegation_Admission.md`.
- Build a host-owned pure decision that classifies a saved parent proposal as solo, eligible to split, or blocked using `hostDelegationPolicy` and the saved Solo/Auto setting. Record a short public rationale. Copy refusal cases from `tests/delegation.test.ts`; no keyword-only claim that a prompt is independently decomposable.
- Verify localized/ambiguous work stays solo, overlapping scopes/cycles/stale base block, and an exact valid independent proposal is eligible. No task, model, process, or worktree creation.

### A2. Focused child kickoff brief

- Branch/worktree: `feat/auto-delegation-brief` / `.preview/worktrees/auto-delegation-brief`.
- Own: new `src/core/autoDelegationBrief.ts`, `tests/autoDelegationBrief.test.ts`, `docs/Auto_Delegation_Brief.md`.
- Build a deterministic display/dispatch brief from `buildChildContext` and selected source references. Keep mandatory repository/user constraints, base, scope, acceptance, and dependency contract; use `assertFreshContext` before dispatch. Read the focused-manifest examples in `tests/delegation.test.ts`.
- Verify no parent/sibling transcript copy, no secret values, explicit refusal when mandatory content exceeds the bound, and stale source refusal. Do not truncate requirements to fit.

### A3. Child scheduling intents

- Branch/worktree: `feat/auto-delegation-schedule-intents` / `.preview/worktrees/auto-delegation-schedule-intents`.
- Own: new `src/core/autoDelegationSchedule.ts`, `tests/autoDelegationSchedule.test.ts`, `docs/Auto_Delegation_Schedule.md`.
- Turn validated prepared children and saved dispatch identities into deterministic queue intents: exact child ID, predecessor IDs, selected base, one managed launch request. Follow `createDelegatedChildren` and `TaskScheduler.configureSchedule` patterns without calling the scheduler yet.
- Verify two independent children may be ready together, a dependent child waits, duplicate/replayed dispatch produces the same intent, and cancelled/uncertain dispatch refuses. Do not create a second worktree or launch from a projection.

### A4. Parent resume payload

- Branch/worktree: `feat/auto-delegation-parent-resume` / `.preview/worktrees/auto-delegation-parent-resume`.
- Own: new `src/core/autoDelegationParentResume.ts`, `tests/autoDelegationParentResume.test.ts`, `docs/Auto_Delegation_Parent_Resume.md`.
- Produce a bounded parent continuation input from saved wakeup and child result receipts. Follow `DelegationWakeup` and `delegationResults.ts`; include result references and unresolved caveats, not full logs.
- Verify simultaneous child completions coalesce, replay is a no-op, missing/failed child blocks successful continuation, and restart yields the same resume identity. No model turn in this module.

### A5. Child acceptance readiness

- Branch/worktree: `feat/auto-delegation-result-readiness` / `.preview/worktrees/auto-delegation-result-readiness`.
- Own: new `src/core/autoDelegationResultReadiness.ts`, `tests/autoDelegationResultReadiness.test.ts`, `docs/Auto_Delegation_Result_Readiness.md`.
- Project whether the current child result, reviewed commit/tree, evidence, and parent review are present and match. Copy exact binding checks from `delegationResults.ts` and `delegationIntegrationGate.ts`; return a reasoned blocker for the parent UI.
- Verify stale tree, missing evidence, rejection, pending writer, and passed child-only checks cannot become accepted integration. Do not call `Integrations.promote` here.

### A6. Stop and restart intent

- Branch/worktree: `feat/auto-delegation-stop-recovery` / `.preview/worktrees/auto-delegation-stop-recovery`.
- Own: new `src/core/autoDelegationStopRecovery.ts`, `tests/autoDelegationStopRecovery.test.ts`, `docs/Auto_Delegation_Stop_Recovery.md`.
- Derive a deterministic stop/recovery intent for parent and direct children from durable scheduler, ownership, and reconciliation facts. Copy the uncertain-writer handling in `scheduler.ts` and `delegationReconciliation.ts`.
- Verify pending dispatch is cancelled, active owned processes require explicit stop, uncertain writers remain held after restart, and no old result triggers a new launch. Do not terminate processes from this pure module.

### A7. Auto rollout and quality decision

- Branch/worktree: `feat/auto-delegation-rollout-policy` / `.preview/worktrees/auto-delegation-rollout-policy`.
- Own: new `src/core/autoDelegationRollout.ts`, `tests/autoDelegationRollout.test.ts`, `docs/Auto_Delegation_Rollout.md`.
- Consume `reportDelegationEvaluation` plus explicit provider acceptance facts to decide whether Auto may be offered beyond opt-in. Preserve the existing `insufficient`, `keep-solo`, and `eligible-for-human-rollout-review` semantics.
- Verify missing usage and smaller/faster-but-costlier samples never claim token savings; one provider's acceptance does not unlock another; no code path flips the default without the later human rollout gate.

### A8. Claude live-acceptance harness

- Branch/worktree: `feat/claude-live-acceptance-harness` / `.preview/worktrees/claude-live-acceptance-harness`.
- Own: new `scripts/claude-acceptance.mjs`, `tests/claudeAcceptance.test.ts`, `docs/Claude_Live_Acceptance.md`.
- Prepare an opt-in local runbook/runner around existing public account status and `ManagedSessions` behavior: subscription-mode status, selected model/effort, command/file approval, interrupt, restart, and resume. Use `src/core/accountSetup.ts`, `managedClaude.ts`, and `tests/managed.test.ts` as examples.
- Fixture mode proves command ordering, redaction, cancellation, and evidence schema without signing in or submitting a real turn. Live results stay pending until a user drives the provider-owned login and explicitly authorizes a bounded task. Never read credentials or silently use API-key billing.

### A9. Codex live-acceptance harness

- Branch/worktree: `feat/codex-live-acceptance-harness` / `.preview/worktrees/codex-live-acceptance-harness`.
- Own: new `scripts/codex-acceptance.mjs`, `tests/codexAcceptance.test.ts`, `docs/Codex_Live_Acceptance.md`.
- Prepare an opt-in runner/runbook for the existing ChatGPT login flow, model/effort acknowledgement, one scoped approval, interrupt, restart/resume, and explicit quota refresh. Follow `CodexAccountFlow`, `ManagedCodex`, `readCodexQuota`, and `tests/quota.test.ts`.
- Fixture mode proves only documented RPCs are sent, identity/reset tokens are absent from evidence, cancellation closes the owned channel, and unavailable quota stays unavailable. Browser opening or executable presence is never recorded as sign-in.

### A10. Distinct-version upgrade evidence

- Branch/worktree: `feat/desktop-upgrade-evidence` / `.preview/worktrees/desktop-upgrade-evidence`.
- Own: new `scripts/desktop-upgrade-evidence.mjs`, `tests/desktopUpgradeEvidence.test.ts`, `docs/Desktop_Upgrade_Evidence.md`.
- Parse the outputs of the existing `scripts/desktop-upgrade-test.ps1` and pinned `desktop/upgrade-baseline.json` into a small provenance record. Copy the manifest/hash/selected-shortcut checks from `docs/Windows_Installer.md`; do not run the installer on a developer profile.
- Verify mismatched version, missing/expired baseline, wrong artifact hash, or missing selected/unselected cycle refuses a passing record. A local parser pass never marks the disposable Windows run accepted.

### A11. Signing and distribution preflight

- Branch/worktree: `feat/desktop-signing-preflight` / `.preview/worktrees/desktop-signing-preflight`.
- Own: new `scripts/desktop-signing-preflight.mjs`, `tests/desktopSigningPreflight.test.ts`, `docs/Desktop_Signing_Preflight.md`.
- Define a read-only release-artifact inventory and signature verification result for the app executable and installer, with exact hashes, product/version identity, and expected signer metadata. Follow `scripts/desktop.mjs` staging/verify pattern.
- Verify unsigned, mismatched, and tampered artifacts fail closed. Do not obtain/store a certificate or claim a signed public release; signing and distribution credentials are a later release-owner gate.

### A12. Native visual/accessibility record

- Branch/worktree: `feat/native-manual-acceptance-record` / `.preview/worktrees/native-manual-acceptance-record`.
- Own: new `scripts/native-visual-acceptance.mjs`, `tests/nativeVisualAcceptance.test.ts`, `docs/Native_Visual_Acceptance.md`.
- Make a local record for a human to review editor/Agents switching, dirty tabs, terminal ownership, keyboard focus, dark/light/high-contrast, reduced motion, onboarding, and installer wizard. Reuse the scope and pending labels in `docs/Native_Workflow_Acceptance.md`.
- Verify a missing human observation or failed keyboard/contrast case cannot become a pass. The existing fixture status remains pending until a real native Hydra window is inspected.

### A13. Update-feed integrity contract

- Branch/worktree: `feat/desktop-update-feed-contract` / `.preview/worktrees/desktop-update-feed-contract`.
- Own: new `src/core/desktopUpdateFeed.ts`, `tests/desktopUpdateFeed.test.ts`, `docs/Desktop_Update_Feed.md`.
- Define a versioned, read-only update manifest parser with channel, full artifact hash, monotonic version, and signature/provenance requirements. It may describe an available update but must never install it. Use `desktop/product.json`, `scripts/desktop.mjs`, and `docs/Desktop_Delivery.md` as the version/identity sources.
- Verify rollback, channel crossing, unsigned metadata, wrong product identity, and missing hash refuse. No endpoint, updater daemon, or automatic installation is invented before the later native update-channel decision.

## Wave B — shared integration, one coordinator writer at a time

These are separate PRs. The coordinator alone edits shared host/model/webview files. Begin each from merged main after the listed Wave A prerequisites land. Existing paths below are intentionally serialized; do not hand the same file to two Terra agents concurrently.

| PR | Depends on | What to connect and where | Exit evidence |
| --- | --- | --- | --- |
| B1 parent Auto submission | A1, A2, A7 | `src/extension.ts` and `src/core/model.ts`: use the normal parent managed turn and `delegationPlannerIngestion.ts` for a validated Solo/Auto decision; persist decision and show rationale. `webview/EditorConversation.tsx` only if status cannot use existing snapshot. | Solo sends one normal turn; Auto makes no extra planner call merely from navigation; malformed plan refuses before child creation; saved choice survives restart. |
| B2 child dispatch and queue | B1, A3, A6 | `src/extension.ts`: reuse `DelegationDispatchStore.materialize`, `createDelegatedChildren`, enrollment transaction and `TaskScheduler.enqueue`. Persist dispatch and task before launch, hold parent capacity only while it writes, and fence cancellation/uncertain writers. | Two independent children start once in separate worktrees under the same capacity; dependency waits; restart during every durable boundary neither duplicates a worktree nor launches an extra writer. |
| B3 parent wakeup and accepted result | B2, A4, A5 | `src/extension.ts`: wake from saved child results, build bounded continuation, use existing parent-review and `Integrations.prepare/promote` gates. | Concurrent completions coalesce, failure/rejection blocks parent success, stale result blocks integration, combined checks decide acceptance, candidate remains recoverable on conflict. |
| B4 orchestration and Editor UI | B3 | `src/core/model.ts`, `webview/index.tsx`, `webview/EditorConversation.tsx`, focused panels and graph styles: show the saved decision, child states, result blockers, actual dispatch/result arrows and partial usage. | Selection and mode switching preserve dirty editor/terminal state; graph navigation makes zero provider calls; keyboard and reduced-motion fixtures pass at narrow/wide widths. |
| B5 combined local acceptance | B4 | New integration fixture(s) plus `docs/Implementation_Status.md`: exercise localized Solo, two independent children, dependent child, blocked result, stop, restart and combined integration in one disposable repository. | `npm.cmd run check`, `npm.cmd run build`, focused tests, full `npm.cmd test`, and supported native smoke pass on the same reviewed head; if native smoke stalls, retain an explicit pending gate. |

## Wave C — real accounts, rollout, and desktop release

These gates can be prepared in parallel after Wave A but cannot be pronounced complete from code alone. Keep separate PRs and evidence records.

1. **Provider acceptance:** use A8/A9 with a human-operated subscription login and explicitly authorized bounded provider turns. Test model/effort acknowledgement, safe approval allow/decline, stop and restart/resume on the pinned Claude and Codex versions. Record the effective authentication mode where public state exposes it. Unknown provider-native nested agents and quota remain unavailable. Do not swap to API billing.
2. **Paired Auto/Solo evaluation:** freeze representative tasks, base commits, provider/model/effort, acceptance commands, sample size and quality tolerance before runs. Use the existing corpus/import/report code and A7. Include retries, failed candidates, coordination, and human review time. Switch the released default to Auto only in a separate reviewed rollout PR after quality holds and measured usage or time improves within the user's declared budget. If evidence is partial, keep Solo default and Auto opt-in.
3. **Native desktop acceptance:** build a fresh standalone runtime, run `desktop:verify` and `desktop:smoke`, then use A12 for a human keyboard/visual review. A stalled smoke is inconclusive. Distinct-version installer upgrade uses A10 on a disposable Windows host; the current pinned baseline expires and may need explicit provenance refresh. Preserve developer profiles and unrelated VS Code/Cursor data.
4. **Signing and updates:** release owner supplies signing identity and distribution destination after A11/A13. Have Astra resolve the consequential Code OSS updater/channel architecture before Terra touches native update services. Then implement one signed update channel, rollback refusal, safe download/install/restart, and a real upgrade/rollback test in separate reviewed PRs. Never claim automatic updates from a manifest parser alone.
5. **Completion record:** update `docs/Implementation_Status.md` with exact PRs and gates, independently verify `origin/main`, and delete this temporary plan only when the code and applicable external acceptance are complete. If live account, signing, or human gates remain pending, retain the plan and name their owner and next action.

The first-wave target is simultaneous *independent* progress, not simultaneous mutation of Hydra's host or a claim that thirteen model processes can fit any local capacity. If the executor has fewer slots, fill available slots with ready tasks and launch the next task as one finishes. A feature counts as done only after its own reviewed PR is merged; the IDE counts as complete only after Wave C's real acceptance and release gates are evidenced.
