# Provider Continuity Plan

## Goal

A provider usage limit should interrupt a **provider session**, not end the Hydra task.

If Claude Code or Codex reaches a usage/quota limit mid-task, Hydra should preserve the exact task worktree and let the user explicitly continue with another available provider. The first concrete fallback can be Freebuff, following the pattern shown by Ninebrains, but the architecture should be provider-agnostic.

Reference:
- https://ninebrains.runs-on.dev/
- https://github.com/Advance-Labs/ninebrains

## Product behavior

When Hydra detects a recognized provider usage-limit failure, show an explicit continuity card in the task conversation:

> **Usage limit reached**
>
> The current provider cannot continue this task right now. Your worktree and task state are preserved.

Suggested actions:

- **Continue with Freebuff**
- **Continue with Codex** when Claude was active
- **Continue with Claude Code** when Codex was active
- **Open terminal**
- **Wait for reset**

Do not silently switch providers.

## What "continue" means

This is **not the same provider conversation**.

It is:

**same Hydra task + same filesystem/worktree state + transferred checkpoint context**

Hydra must not claim transcript/session portability across providers unless the provider explicitly supports it and Hydra has verified that path.

## Handoff flow

When the user chooses another provider:

1. Stop or release the current task writer and reconcile ownership.
2. Preserve the exact worktree, branch, files, staged/unstaged state, and untracked files.
3. Generate a deterministic local handoff note without a model call.
4. Launch/open the selected provider in the same task worktree.
5. Copy or inject the bounded handoff note using only a verified provider surface.
6. Record a durable provider-handoff event in Hydra's orchestration history.

Hydra should never allow two provider writers to own the same task at once.

## Handoff note

Reuse Hydra's existing task context/handoff infrastructure. The generated checkpoint should include only the context needed to continue:

- task goal and acceptance criteria
- constraints and relevant paths
- previous provider and interruption reason
- base commit and current branch/worktree identity
- current `git status --short`
- changed paths
- reviewed/recorded commit if one exists
- completed work
- unresolved work / next intended action
- validation already run and evidence references
- known failures/blockers

Suggested provider-facing instruction:

> Continue this existing Hydra task in the current worktree. Start by inspecting `git status` and `git diff`, read the handoff summary and relevant files, then continue from the current state. Do not assume the previous provider conversation is available.

Do not paste the full prior transcript by default.

## Detection

Treat quota detection as provider-specific, versioned adapter behavior.

A continuity offer should appear only when Hydra has strong evidence that the provider stopped because of a usage/rate/quota limit. Unknown failures should remain ordinary errors rather than being mislabeled as quota exhaustion.

Persist:

- provider
- detected limit category
- raw diagnostic/evidence reference
- detection timestamp
- known reset time/window when authoritatively exposed
- handoff chosen or dismissed
- destination provider
- resulting writer/session identity

Provider-owned quota data that is unavailable stays unavailable.

## Freebuff

Ninebrains currently presents Freebuff as a fallback that opens in the same worktree and receives a copied handoff note after Claude Code or Codex reaches a usage limit.

Hydra should borrow the workflow, not hard-code product claims.

For an initial Hydra implementation:

- verify the supported Freebuff launch surface and worktree/CWD behavior
- prefer an explicit external handoff before building a custom managed adapter
- keep credentials/authentication provider-owned
- do not hard-code that Freebuff is unlimited or permanently free
- preserve the existing one-writer-per-task rule

Once a stable public integration surface is verified, Freebuff could become a first-class provider adapter.

## Generalized provider continuity

The architecture should support:

```
Claude Code -> Codex
Codex -> Claude Code
Claude Code -> Freebuff
Codex -> Freebuff
Freebuff -> Claude Code/Codex
```

The available destinations should be computed from installed/configured providers and capability checks rather than hard-coded UI.

A future routing policy could suggest a destination based on availability, user preference, task compatibility, model capability, and remaining provider quota, but the user must approve the switch.

## State model

Suggested host-level states/events:

```
running
  -> interrupted_quota
  -> awaiting_handoff_choice
  -> handing_off
  -> idle/running_with_new_provider
```

Durable event example:

```json
{
  "kind": "provider-handoff",
  "taskId": "...",
  "from": "claude",
  "to": "freebuff",
  "reason": "usage-limit",
  "worktree": "...",
  "checkpointSha256": "...",
  "occurredAt": "..."
}
```

Provider-specific session IDs remain separate. Never mutate an old provider session record to pretend the new provider owns it.

## UI / graph behavior

In the task conversation:

- show the usage-limit interruption inline
- show the available continuation actions
- keep the current task selected
- make it clear that files/worktree are preserved
- label the new provider after handoff

In the orchestration graph/history:

```
Claude Code -- usage limit --> Freebuff
```

This edge represents a real persisted handoff event, not inferred communication.

## Interaction with Hydra foundations

This should reuse, not replace:

- isolated task worktrees
- writer ownership and external handoff guards
- task/session persistence
- local handoff artifacts
- provider capability/version checks
- task/project usage accounting
- provider usage-limit observations
- scheduler capacity/profile reservations
- stop/interruption behavior
- verification and integration gates

A provider handoff does **not** reset task budgets, verification requirements, dependency state, or review history.

## Safety / correctness rules

- No silent provider fallback.
- No two active writers for one task.
- No claim of cross-provider conversation continuity.
- No automatic replay of the entire previous transcript.
- No provider credential extraction or migration.
- No bypass of pending approvals, failed gates, budget holds, or dependency blockers.
- Reconcile uncertain/interrupted writers before launching the destination provider.
- Preserve all worktree state before handoff.
- Keep quota detection evidence inspectable.

## Suggested implementation order

### Phase 1 — explicit cross-provider continuation

Use existing Claude/Codex handoff infrastructure to allow an interrupted task to continue in the other supported provider, in the same worktree, with a deterministic handoff note.

### Phase 2 — quota-aware UX

Add reliable provider-specific usage-limit classification and the inline **Continue with...** card.

### Phase 3 — Freebuff external handoff

After verifying a stable public launch/integration surface, add Freebuff as an explicit same-worktree fallback.

### Phase 4 — generalized provider routing

Expose all verified providers through a common continuity capability and record provider-switch events in the orchestration graph.

## Acceptance criteria

A feature is not complete until tests prove:

- a quota interruption never deletes or resets the task worktree
- the previous writer is stopped/released before the next writer starts
- the destination opens in the exact same canonical worktree
- staged, unstaged and untracked changes remain intact
- the handoff artifact is deterministic and bounded
- no full transcript is copied automatically
- a provider switch survives Hydra restart
- duplicate handoff requests cannot create duplicate writers
- dependency, budget, review and verification state survive the switch
- unknown provider errors do not appear as usage limits
- the graph/history records the actual handoff
- cancellation during handoff leaves the task recoverable

## Product copy

A concise Hydra version:

> **A usage limit does not end the task.**  
> If one coding agent runs out of usage, keep the same worktree and continue with another available provider.

The product concept is stronger when framed as **provider continuity**, with Freebuff as one possible destination rather than the entire feature.
