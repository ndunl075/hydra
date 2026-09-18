# Delegation contract and context preparation

Status: preparation for phase 1 of [Adaptive Delegation](Adaptive_Delegation.md). The standalone helpers are exercised by fixtures and are not connected to the Manager, provider dispatch, Editor composer, Settings or graph. The existing Editor runtime and manual tasks remain the active product behavior. This preparation does not complete phase 1 or enable automatic delegation.

## Host contract

`prepareDelegation` accepts a version-1 model proposal and a separate host policy. The policy supplies parent/run identity, Solo/Auto choice, parent level, entire-run child allowance (default two), inherited provider/model/effort, host-verified full base commits, authorized literal paths, paths owned elsewhere and mandatory context. Host input is never accepted from extra fields in the model proposal.

Solo and child tasks reject delegation. Proposals require a short rationale and each writing child's goal, deliverable, recorded base, ownership, dependencies, acceptance criteria and selected context keys. Validation rejects malformed identities, cycles, missing dependencies, unknown bases, scope expansion, other owners' paths and unsupported or substituted settings. The existing pinned provider catalog validators are reused; actual effective model acknowledgement remains a dispatch requirement.

Independent scopes retain parallel eligibility. Windows case-insensitive overlap inserts inspectable dependency edges without reversing existing ordering. Literal paths exclude traversal, globs, Git metadata, trailing spaces/periods and [Windows reserved device names](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file), including superscript COM/LPT variants. A trailing slash declares directory ownership; other paths declare files. This lexical assignment is not a filesystem sandbox. The eventual host must resolve filesystem aliases/links, verify actual Git objects, source provenance and writer absence, and refresh other-owner assignments before execution.

## Focused child context

`buildChildContext` uses supplied content only. Mandatory user intent, quality, constraints, repository instructions and agreed interfaces survive alongside ownership, base, acceptance, suggested checks and execution limits. Children select only evidence already approved by the host. It never reads the repository, copies a parent/sibling transcript, runs a tool or calls a model.

The manifest records each source path, revision, inclusion reason and content hash. Source excerpt whitespace is preserved. Oversized briefs are refused at 32,000 characters with revision guidance; required material is never silently truncated. This character bound is not a token count. `assertFreshContext` compares freshly supplied host revision/hash observations and detects modified manifests. These hashes provide consistency checks, not authentication or a replacement for host trust/provenance.

## Decisions across restart

`DelegationStore` saves per-parent-run decisions independently of task/session metadata. Each call snapshots and validates input, requires an ownership callback, obtains an exclusive per-run write lock, reads existing decisions and counts all accepted child keys. Replanning and replacements cannot reset the run count. Identical input and host policy return the same receipt without charging twice; changed input/policy requires a new decision ID. Selected evidence and relevant model metadata are retained; unselected source content is omitted.

Writes sync a unique temporary file before atomic replacement, rechecking host and lock ownership first. Reads validate schema, receipt consistency, complete run counts and overlap. Corrupt/oversized data and foreign/replaced locks retain existing bytes. Locks are never reclaimed by PID or age; after a crash the owning host must reconcile the retained lock explicitly. This implementation has no automatic reconciliation action. Filesystem/power-loss durability and malicious external replacement are separate from these process-restart fixtures.

Prior accepted scopes remain conservative reservations for planning: overlapping replanning is refused pending future writer/result reconciliation. Loading returns detached prepared decisions; it dispatches nothing. Future orchestration must add durable child lifecycle/result state and current-policy revalidation before any receipt becomes executable.

## Remaining gates

The guide's composer/Settings controls, real decision quality, Manager integration, shared-capacity parent suspension/wakeup, child worktrees, stop/recovery, budget aggregation, results/integration and graph/accounting are still planned. Provider/live/manual/release prerequisites continue to apply. Auto remains opt-in during development and needs repeated matched quality/efficiency evaluation before becoming a default. This contract makes no savings or automatic execution claim.
