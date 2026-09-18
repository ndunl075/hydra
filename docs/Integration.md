# Reviewed task integration

A reviewed task commit can be merged into a detached candidate beside the task worktrees. Preparing a candidate preserves the task branch and target checkout. Choose acceptance checks as executable/argument JSON; commands run only after an explicit preparation or resolved-candidate acceptance, with a two-minute limit and bounded retained logs. Windows command shims reject shell metacharacters.

Native Git performs the merge and runs its hooks. Conflicts retain the candidate for manual resolution: copy its path, resolve and commit there, review the fixed target-to-candidate diff, then explicitly accept that resolution and rerun the checks. There is no automatic conflict resolution or discarding of edits.

Promotion requires the reviewed task commit, original target HEAD/branch, detached candidate commit/tree, passed checks, saved editor buffers, and clean checkouts to still match. It fast-forwards through the target's owning checkout. A reference under `refs/hydra/integration-backups/<operation>` retains the prior target commit; candidates and task worktrees remain available for inspection. Restoring that reference is a separate manual Git action.

Integration journals survive reloads. Interrupted preparation/checks/resolution are marked interrupted; commands are never replayed. A completed promotion is recovered only after checking target commit/tree, both ancestors, passed checks and rollback reference. Invalid journals are retained and block recovery rather than silently reset. A lock in the repository common Git directory prevents competing integrations across Hydra profiles.

Validation covers real-Git ordered integrations, retained rollback/task trees, native conflicts and reviewed resolution, stale/dirty/writer refusal, cancelled and mutating checks, restart recovery, command validation and shared locking. Native desktop smoke exercises commands, immutable diff and promotion without model calls. Account acceptance and full installer delivery remain separate milestones.

PR #22 passed Linux and [Windows native acceptance](https://github.com/ndunl075/hydra/actions/runs/35286211250) at `d99ba70`. See the [combined acceptance record](Implementation_Status.md#acceptance-record) for later bundled revisions.
