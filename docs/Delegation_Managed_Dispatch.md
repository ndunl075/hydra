# Delegated managed dispatch

Feature 08 may launch only a child that has an immutable delegation link and an explicitly enrolled schedule. The scheduler remains the sole capacity, budget, dependency, and stop authority.

| Transition | Durable boundary | Owner |
| --- | --- | --- |
| enrolled to queued | scheduler request saved | scheduler |
| queued to starting | reservation saved before adapter/process work | scheduler/host |
| adapter session acknowledgement | session identifier saved immediately | managed adapter callback |
| restart during starting/running | mark uncertain; never retry automatically | scheduler reconciliation |

The child keeps its existing worktree, base commit, provider, model selection, and dependency order. A duplicate writer, unresolved pending journal marker, unmet dependency, budget hold, capacity refusal, or stop prevents launch. This feature does not wake a parent, create a planner turn, create descendants, or change a model/provider.

A version-1 execution receipt is saved in the same task-store transaction as the queue request. It binds the dispatch to the exact child identity, worktree/base, provider, model/effort, dependencies and bounded prompt. At the scheduler's final launch gate, `starting` is saved before host diagnostics or provider creation. The existing workspace writer lock, profile reservation, scheduler capacity and budget checks continue to own dispatch authority.

Codex identifies a thread before `turn/start`; its observer must finish saving the receipt before that request is sent. Claude identifies its session after the initial user frame, so Hydra saves that acknowledgement immediately and withholds approvals/completion until the save finishes. Both adapters retain process ownership while an acknowledgement is in flight, including Stop/exit races. An acknowledgement failure stops the provider and preserves an uncertain receipt instead of claiming successful execution.

After restart, active schedules become uncertain and retain capacity until explicit writer reconciliation. An attempted initial dispatch with no recovered session is never automatically retried. Later explicit retry policy belongs to Feature 09. A resumed session must match the saved provider and receipt identity. A child gets only its recorded bounded prompt; the parent planner suffix is omitted, preventing recursive planning.

These guarantees are fixture-tested. They do not assert that a provider turn passed verification, completed integration, or saved tokens.
