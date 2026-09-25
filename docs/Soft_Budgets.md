# Soft launch and turn budgets

> **Removed (2026-09-24).** This described part of Hydra's managed-task system, which was removed once the Agents view became a live canvas of Hydra heads (see [Agents_View_Plan.md](Agents_View_Plan.md), "As built", and [Heads.md](Heads.md)). Kept for history; none of it is in the product any more.

Hydra can warn or hold new terminal launches and managed turns when recorded usage reaches an explicit task or project limit. Budgets default to off. Configure **Soft budgets** on a task, choose task/project and provider, enter positive limits, and save. Claude and Codex settings remain separate; a task hold or project hold can stop new work for its provider.

## Measurements and scope

Token limits use that provider's reported input plus output. Codex input includes cached input; Claude cache categories are separate and excluded from this token limit. Claude can also use a reported API estimate in USD. Either reached configured limit activates the rule. These are not subscription bills, account quotas, remaining credit, or forecasts of the next turn's cost.

Totals use complete local managed histories, independent of display truncation. Repeated Codex cumulative snapshots replace earlier observations; each root thread counts once in the project total. A provider reset can lower its latest snapshot. Project budgets include retained discarded tasks in the same canonical repository and this Hydra workspace's store. Other windows, unrecorded terminal/extension activity, and provider-dependent nested-agent coverage are outside this total.

Missing measurements remain **Unavailable** and do not activate a limit. Measured tokens with incomplete coverage are labeled accordingly and can still reach a threshold. A missing Claude monetary estimate in an aggregated result keeps the monetary total unavailable. See [reported usage semantics](Task_Context_And_Usage.md#provider-semantics).

## Launch behavior and recovery

**Warn** displays reached limits and allows the requested work. The launch record retains warning messages. **Hold** preserves the exact queued request and follow-up text, records a budget reason, and starts no model turn. Checks run on enqueue, during queue drain (even while capacity is full), after dependency preparation, after provider probes, before Claude process creation, and before Codex thread/turn submission.

Changing/removing a budget never automatically resumes a held request. Choose **Retry held launch** to check the current settings and usage again, or **Cancel queued launch** to clear its request. Restart retains settings, the hold and its prompt. An initial Codex launch held after native thread creation retries that saved thread with the unchanged initial prompt. Failed budget saves leave the prior settings active; failed retry persistence restores the held scheduling record. Session metadata writes cannot overwrite the separate atomic budget store. Invalid store data is retained and disables launches through the existing unhealthy-workspace gate.

Running turns, pending approvals and already-open terminals continue. A soft limit is not an enforced in-flight spending cap and does not reserve allowance for simultaneous work. A new provider terminal can be held using known managed history, but activity after opening it is not measured or controlled by Hydra. Official-extension handoffs remain externally owned and are outside launch-budget enforcement. No model/effort downgrade, authentication substitution, automatic summarization or billing fallback occurs.

## Acceptance

Local checks cover positive/unique provider settings, task/project scopes, unavailable metrics, provider/cache separation, repeated cumulative events, retired-task coverage, atomic reload and failed writes, explicit retry, cancellation, queue/preparation races, failed retry persistence, and retained Codex session identity. Fake-provider regressions verify that late Claude/Codex gates submit no model request. Native smoke adds project holds for an unmeasured task, warning-only retry, exact retained follow-ups with zero requests, and restart acceptance. Browser controls are checked separately. These fixtures do not establish live account quotas, an account-wide spending cap, or measured efficiency savings. Final Linux and standalone Windows gates are required before merge.
