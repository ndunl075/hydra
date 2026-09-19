# Delegation graph handoff wiring

The host emits a `dispatch` graph event only after the materialized dispatch and matching child task have both been durably saved. Startup replays those durable records through the idempotent producer, so a graph-journal failure leaves the dispatch recoverable without launching a task.

`hydra.receiveDelegationResult` writes its exact result receipt and delivery timestamp through the ingress boundary first. Only after that journal append succeeds does it emit the corresponding `result-delivery` event, using the receipt hash as the durable source identity. A graph append failure is returned to the caller; replaying the same receipt reuses the persisted timestamp and does not accept new provider text. Receipts created before this timestamp existed remain inspectable but do not create a graph event.

Feature 29 does not wire `approval-pause`. The current task and scheduler records expose an approval state but no immutable, per-pause durable record ID that can be bound to a child dispatch. The host therefore emits no approval arrow from that state. A future transition must persist that identity before calling `pausedAfterApproval`.
