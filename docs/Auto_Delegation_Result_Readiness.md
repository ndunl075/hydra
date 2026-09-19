# Auto delegation result readiness

`assessAutoDelegationResultReadiness` is a pure parent-UI projection for one direct delegated child. It reports whether the selected child has the durable inputs required to begin the existing combined integration checks.

The projection binds the selected child delegation identity to the supplied result binding, result receipt, reviewed commit/tree, verification evidence, and explicit `parent-human` review receipt. It reuses the authoritative parsing and approval checks in `delegationResults.ts`, `delegationEvidence.ts`, and `delegationParentReview.ts`.

It fails closed with a reasoned blocker when the child is a pending or uncertain writer, the result source is absent or mismatched, the result/evidence boundary is stale or invalid, or the parent review is absent, rejected, malformed, or stale. A `ready-for-integration-checks` result means only that these child prerequisites match. It does not prepare a candidate, run combined acceptance commands, call `Integrations.promote`, or mutate tasks, journals, worktrees, provider sessions, or preferences.

The existing integration gate remains authoritative for every direct child and the normal candidate checks remain the only path that can decide promotion.
