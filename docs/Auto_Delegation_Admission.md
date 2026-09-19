# Auto delegation admission

`admitAutoDelegation` is a pure host decision for a saved delegation proposal. It returns one of three visible outcomes:

- `solo` when the saved proposal says the parent should continue alone, including localized or unresolved work.
- `eligible` only for a host-bound Auto proposal with at least two concrete children, distinct write scopes, an approved current base, valid dependencies, ownership, provider settings, and child context.
- `blocked` when the host binding or existing delegation validation refuses the saved proposal. Child write-scope overlap is blocked here rather than serialized, because admission only accepts independently useful work.

The function uses `hostDelegationPolicy` to bind parent identity, saved Solo/Auto preference, base commit, provider, and model selection. It then uses `prepareDelegation` for the existing policy checks. It does not create tasks, worktrees, processes, provider turns, reservations, or dispatch records.

Admission does not infer decomposability from prompt keywords. A model or other caller must supply a concrete saved proposal with child goals, ownership, dependencies, acceptance criteria, and context references. Later host integration is responsible for persistence and any dispatch after an `eligible` outcome.
