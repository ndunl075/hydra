# Auto Delegation Stop Recovery

`deriveAutoDelegationStopRecoveryIntent()` is a pure projection for one selected
parent run and its direct children. It accepts only durable task scheduler
records, an already-produced reconciliation projection, and a caller-supplied
ownership fact. It does not acquire or release an ownership lock, write durable
state, drain a scheduler, create a launch request, or terminate a process.

| Durable condition | Intent | Required host action |
| --- | --- | --- |
| Pending child dispatch | `cancel-pending-dispatch` | Persist cancellation through the existing dispatch/scheduler path. |
| Active writer owned by this window | `stop-owned-writer` | Ask for and perform an explicit stop through the owning host. |
| Active writer owned elsewhere or with unknown ownership | `hold-unowned-writer` | Keep the run held; do not touch another or unknown writer. |
| Scheduler or execution receipt uncertain after restart | `hold-uncertain-writer` | Keep capacity/reservation held until explicit reconciliation. |
| No pending or active writer | `none` | No recovery operation is implied. |

Reconciliation facts must cover exactly the direct children of the selected
parent/run. Missing, duplicate, or mismatched facts are rejected. Uncertain
state takes precedence over ownership because a process may have escaped before
the prior host stopped. The output has no launch action: a reviewed commit or
any older result cannot restart a child. A later explicit scheduler enqueue is
the only path that can request another writer.
