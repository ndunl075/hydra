# Auto delegation schedule intents

`createAutoDelegationScheduleIntents(decisions, dispatches)` is a pure host-side projection from `PreparedDelegation` and saved `DelegationDispatch` receipts to a stable list of child scheduling intents.

Each intent carries the exact materialized child task ID (`worktreeId`), its immutable `dispatchKey`, selected child base commit, predecessor task IDs, and exactly one `{ type: 'startManaged' }` request. Independent children are `ready`; a child with predecessors is `waiting-for-predecessors`. The later shared scheduler decides when a waiting child can queue and launch after reviewed predecessor receipts exist.

The projection requires a one-to-one set of materialized dispatch receipts matching the validated parent ID, run ID, child key, and base. Reserved, uncertain, cancelled-equivalent, missing, duplicate, or mismatched receipts refuse. Replaying the same prepared decision and receipts returns the same values.

This module does not write task state, create a worktree, enqueue a scheduler request, prepare a checkout, reserve capacity, or launch a provider. Wave B owns persisting these intents and passing their request through the existing `TaskScheduler` boundary.
