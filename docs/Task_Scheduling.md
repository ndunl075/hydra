# Persistent task scheduling

Hydra queues terminal launches, initial managed turns, and explicit follow-ups in its local task store. A launch at available capacity proceeds immediately; excess launches wait. The existing per-window default remains two, configurable from one to eight. Official-extension sessions are externally owned and shown separately; Hydra does not limit those sessions or nested provider workers.

The scheduling record is separate from provider task state. It persists `queued`, `starting`, `running`, `waiting-for-approval`, `blocked`, `interrupted`, `finished`, and `cancelled`. `finished` describes a provider/process lifecycle, not acceptance of task results. Managed approvals remain in the conversation and the Attention filter.

## Queue and recovery

- Launch intent and `starting` are saved before preparation or process creation. Launches are serialized through one drain operation; running terminals and managed processes share capacity.
- Cancel queued work without starting a process. Stop running work through the existing provider stop action. Failed preparation or launch is held in `blocked`; it never automatically retries.
- Queued requests survive reload. Any task recorded as starting, running, or awaiting approval becomes interrupted with an uncertain writer reservation. Legacy running terminals/managed sessions receive the same reservation. Such a task continues to occupy capacity until the user stops any surviving process and explicitly acknowledges writer absence. Hydra does not claim OS-level proof that a crashed host's descendants are gone.
- Resume a recorded managed session by sending an explicit follow-up. If an initial launch partially established a session, cancel its blocked initial request and use a follow-up.

## Dependencies and starting commits

The create form accepts an optional full commit SHA. Hydra resolves that commit and creates the isolated checkout there while retaining the main checkout's branch as integration target.

Scheduling controls select prerequisite tasks in the same repository. Cycles are rejected before saving. A prerequisite without a reviewed result waits; failed, cancelled, missing, or interrupted prerequisites block the dependent until explicitly resolved. Review and commit an intended result to resolve a failed/interrupted predecessor, then save the dependent's dependencies to retry. The reviewed result proves user review of that Git tree, not test acceptance.

Saving dependencies pins available reviewed receipts. Immediately before preparation, Hydra checks the predecessor branch, clean saved/index state, absence of hidden index entries and unfinished Git operations, current HEAD/tree, and unsaved buffers visible to the owning window. A changed receipt or dirty predecessor blocks launch until explicitly accepted again. The task records dependency receipts and its actual starting commit. No predecessor transcript is attached.

One prerequisite may supply the initial checkout. This requires an unstarted dependent still at its original base, a clean checkout, and a fast-forward to the reviewed predecessor commit. Hydra never resets local work or merges multiple prerequisites automatically. Subsequent launches preserve the dependent checkout and record its current HEAD. A crash between fast-forward and metadata persistence leaves recoverable Git state; reconcile the writer and inspect the checkout before retrying.

## Validation and remaining scope

`tests/scheduler.test.ts` exercises queueing past capacity, persisted reload, uncertain reservations, duplicate dispatch refusal, cancellation, dependency cycles/failure, persistence errors, and real-Git selected bases, reviewed receipts, dirty-state refusal and predecessor fast-forward. Existing managed provider tests supply bounded protocol fixtures; these are not authenticated provider acceptance.

This feature does not increase the default concurrency, implement automatic task decomposition, prove provider authentication/acceptance, isolate ports or databases, impose token budgets, or provide cross-window global capacity. Safe integration and real-provider acceptance remain separate release prerequisites before expanded concurrency.
