# Focused task context and reported usage

> **Removed (2026-09-24).** This described part of Hydra's managed-task system, which was removed once the Agents view became a live canvas of Hydra heads (see [Agents_View_Plan.md](Agents_View_Plan.md), "As built", and [Heads.md](Heads.md)). Kept for history; none of it is in the product any more.

This milestone adds editable task briefs, local handoff notes, and usage accounting. It implements part of roadmap priorities 3 and 4. It does not complete provider acceptance, model controls, budgets, or dependent-task artifact transfer.

## Briefs and submitted prompts

New tasks offer goal, constraints, relevant paths/symbols, acceptance criteria, and suggested test commands. The exact initial prompt is previewed before creation and persisted as `task.prompt`. The extension rebuilds and validates that preview rather than trusting mismatched client text. Each field is bounded and the rendered prompt is limited to 32,000 characters.

Only entered text is included. File references do not read/attach file contents; other tasks and transcripts are never included automatically. Suggested commands are advisory text: saving a brief does not execute them or authorize integration checks.

The initial brief can be edited while an idle task has never launched. Queue submission locks it durably before enqueueing, including attempts that subsequently fail. Queued requests, recorded starting commits, and uncertain writers also refuse brief edits after reload. Recorded sessions and managed histories also prevent edits. Existing plain prompts remain valid and their unchanged preview matches the saved text exactly; unsaved edits are labeled as a draft until saved. Editing one converts it into a structured brief. Follow-up text remains explicit and uses the provider's native session resume. The managed history and raw evidence retain exact submitted text. Provider-owned instructions and native session context are additional to Hydra's visible submitted prompt.

## Local handoffs

Task-local notes record the result, decisions, validation, unresolved work, and changed paths/evidence references. Save notes, then choose **Open local handoff file** to assemble `sessions/<task-id>/handoff.md` in Hydra storage. Opening regenerates the artifact from saved notes, the task's recorded reviewed commit/tree, and full managed-history/raw-event paths. Edit the source notes in Hydra; direct saved edits to the generated artifact are replaced on regeneration. Unsaved generated notes block regeneration and remain intact.

No summarization model call occurs. Notes are user-supplied, and a finished provider turn is not proof of successful validation. A reviewed-commit receipt is historical and may predate subsequent edits. The file can be inspected and explicitly referenced in another task; automatic dependency artifact selection/review is deferred.

## Provider semantics

Usage is recomputed locally from complete durable managed histories, independent of the ten-turn/50,000-character display limit. Task and project views remain separated by provider because their input/cache semantics differ.

| Report | Accounting |
| --- | --- |
| Claude `result.usage` and optional `total_cost_usd` | One tagged result per Hydra turn; duplicate result events already fail validation. Input, output, cache read/creation and API estimate remain separate. |
| Codex `tokenUsage.last` | Latest model response, shown with that label; never summed as a managed-turn total. |
| Codex `tokenUsage.total` | Persist the cumulative root-thread snapshot with its thread ID. The latest recorded snapshot for each thread is counted once, including native resumed-session history. Repeated events replace snapshots rather than adding deltas. |
| Older records without usage provenance, absent totals, terminal/official-extension work | Unavailable for aggregate accounting. Raw prior observations remain retained; no fabricated reconstruction. |

Codex cached input is included in its input figure. Claude reports cache categories separately. Missing optional cache/cost measurements remain unavailable; project sums do not treat unknowns as zero. Failed/interrupted turns retain any reported usage. Estimates are not subscription bills or remaining quota. Nested-agent coverage is provider-dependent, and root-thread snapshots do not claim complete account-wide usage. Cumulative resets replace the snapshot rather than manufacturing positive deltas.

The pinned [Codex 0.154.0 token protocol](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs) stores `total_token_usage` separately from `last_token_usage`; `append_last_usage` adds the response into the cumulative value and replaces `last`. The [official App Server contract](https://learn.chatgpt.com/docs/app-server) documents root-thread usage notifications. [Claude cost guidance](https://code.claude.com/docs/en/costs) distinguishes API estimates from subscription accounting.

## Validation and remaining scope

`npm run check`, `npm run build`, and the combined local fixture suite passed on Windows. Added tests cover explicit context only, invalid/oversized input, durable queue locks, cancellation, empty-goal refusal, legacy and draft previews, persistence, stale prompt mismatch refusal, local artifacts, duplicate cumulative events, thread identity filtering, restart recovery, missing measurements, and project aggregation over more than ten turns.

Native smoke assertions cover editing a brief, exact fake-provider input, queued and post-launch edit refusal, dirty generated handoff preservation, evidence, and reported usage. Local execution was blocked before host startup by the installed VS Code updater mutex; PR #21 subsequently passed Linux and [Windows native acceptance](https://github.com/ndunl075/hydra/actions/runs/35287795340) at `4b4054a`. The actual built UI also passed browser checks for brief/local-note messages, unsaved handoff refusal, launch locking, dark/light rendering, and content security policy. These are fixture-based checks, not authenticated provider acceptance or demonstrated token savings. See the [combined acceptance record](Implementation_Status.md#acceptance-record) for later bundled revisions.

The separate [Codex model-controls milestone](Model_Controls.md) adds model/effort discovery and effective-setting validation on resume. Astra High requires an exact runtime-advertised match; account availability is unverified. [Soft budgets](Soft_Budgets.md) add explicit reported-usage warnings/holds for new launches and turns; measured efficiency remains separate work. Tasks without an explicit selection continue to use official provider configuration.
