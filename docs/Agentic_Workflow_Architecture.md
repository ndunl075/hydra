# Agentic IDE architecture: efficient parallel work

Researched 2026-09-17. Scope: Zed, Cursor, VS Code, Claude Code, Codex; recommendations for Hydra.
Goal: maximize accepted, tested changes per token and unit of time. Parallelism improves latency only when work is separable; it does not create extra provider quota.

## 1. Verified patterns worth borrowing

| System | Documented architecture / behavior | Hydra implication |
| --- | --- | --- |
| Zed | External agents are separate processes connected through ACP; native agent configuration/auth remain distinct from Zed's built-in agent. [External agents](https://zed.dev/docs/ai/external-agents) | Keep provider-owned sessions behind adapters; do not rebuild their agent loops. |
| Zed parallel agents | Independent threads can use different agents. Worktree picker creates detached checkouts; setup hooks initialize them. Archiving eligible threads saves Git state and removes their worktree; restoration recovers it. [Parallel agents](https://zed.dev/docs/ai/parallel-agents) | Model conversation lifecycle separately from checkout lifecycle. Offer explicit isolated tasks and recoverable archival. |
| Cursor | Managed worktree setup uses OS-specific or generic commands in `.cursor/worktrees.json`; docs discourage symlinking dependencies. [Worktrees](https://cursor.com/docs/configuration/worktrees) | Prepare each environment deterministically before spending model tokens debugging setup. |
| VS Code | Separates agent harness, session, interface, and execution environment; offers workspace/worktree and local/remote/cloud choices. Worktrees are not security boundaries. [Architecture overview](https://code.visualstudio.com/docs/agents/overview) | Preserve native editor/terminal UX; track execution location and permissions independently. |
| Codex | App Server exposes structured threads, turns, notifications, resume and interruption. Desktop worktrees provide separate checkouts and local/worktree handoff. [App Server](https://learn.chatgpt.com/docs/app-server), [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) | Continue explicit thread-ID resume; keep Git ownership in Hydra. |
| Claude Code | Programmatic CLI/SDK retains the agent loop and context management. Subagents isolate intermediate context and return results; teams add independent contexts and coordination cost. [Programmatic use](https://code.claude.com/docs/en/headless), [Subagents](https://code.claude.com/docs/en/sub-agents), [Teams](https://code.claude.com/docs/en/agent-teams) | Use bounded delegation for independent work; avoid a permanent swarm for small edits. |

ACP is editor↔agent JSON-RPC with capability negotiation, session updates, permission requests and cancellation; MCP supplies tools/context. Neither protocol itself guarantees token savings or filesystem isolation. ACP is an optional interoperability adapter, not a prerequisite for Hydra's native providers. [ACP contract](https://agentclientprotocol.com/protocol/v1/overview)

These are documented interfaces and workflow patterns, not a source-code audit of competitors or comparative efficiency benchmarks.

### Ninebrains review decision (2026-09-18)

Adopt the following product patterns from the [Ninebrains architecture](https://github.com/Advance-Labs/ninebrains/blob/main/docs/guide/architecture.md). This is a review of documentation and selected source files, not runtime acceptance or an efficiency benchmark. These additions are planned, not shipped; retain Hydra's Code OSS foundation, Cursor-style Editor mode, and adaptive Solo/Auto policy.

- **Per-attempt verification evidence:** each task exposes its tested commit/tree, command and exit status, review findings, relevant screenshot artifacts, timestamps, and retry history. Keep complete logs locally and pass concise evidence references to agents. Screenshots and model review apply when relevant to the task; do not impose expensive checks on every trivial edit.
- **Required checks block completion:** missing runners, absent evidence, interrupted checks, failed checks, and stale snapshot receipts cannot satisfy a required gate. Show the blocker and preserve work. A provider's completion message is not verification; combined integration acceptance still follows child checks. Ninebrains' [verification handler](https://github.com/Advance-Labs/ninebrains/blob/main/apps/emdash-desktop/src/core/features/brain/node/verification.ts) includes a no-runner fallback that records a pass with an unverified note; Hydra must not adopt that behavior for required gates.
- **Focused agent workspace:** selecting an agent in the orchestration graph opens its worktree identity, terminal/session, diff, verification evidence, and available preview together. Keep the native Editor layout and make unavailable or stopped resources explicit. Selection must not launch a process, submit a model turn, or rerun verification.
- **Visible lifecycle:** derive queued, running, validating, blocked, and completed indicators from durable host state. Use actual assignment and result events for connecting arrows; distinguish agent execution completion from accepted task completion.

Keep focused briefs, explicit missing-context requests, bounded retries, and deterministic dispatch from Hydra's existing design. Do not switch to an always-running coordinator or assume more agents save tokens. No Ninebrains code is incorporated by this decision; any future reuse needs applicable license and attribution review.

Delivery: complete managed delegation and recovery first (Adaptive Delegation Phase 2), then evidence and required-gate enforcement (Phase 3), then the focused workspace and lifecycle graph (Phase 4). Each is a separate locally verified feature PR. See [delivery gates](Adaptive_Delegation.md#delivery-and-acceptance) and the [roadmap](Agent_Workflow_Roadmap.md#6-adaptive-delegation-and-focused-subagent-context).

## 2. Hydra baseline

Snapshot: [c88f9be](https://github.com/ndunl075/hydra/tree/c88f9beea25c6caaa0824623b8252b23f9cd8568).

This baseline is historical. Subsequent implementation and exact-revision acceptance gates are recorded in [implementation status](Implementation_Status.md#acceptance-record) and the [agent workflow roadmap](Agent_Workflow_Roadmap.md). The proposals below remain design rationale; implemented foundations do not establish authenticated provider acceptance or measured efficiency.

- [worktrees.ts](../src/core/worktrees.ts): unique branch + sibling checkout, pinned base commit, recorded integration target, canonical-path checks.
- [Provider_Protocol.md](Provider_Protocol.md): Claude CLI 2.1.270 streaming/resume and Codex App Server 0.154.0 pinned protocol; explicit provider identity, approvals and stop behavior.
- [model.ts](../src/core/model.ts): task/session identity and per-turn input/output/cache usage. [handoff.ts](../src/core/handoff.ts): official-extension workspace handoff.
- [Implementation_Status.md](Implementation_Status.md): writer exclusion/concurrency and native immutable review foundations exist. Queueing, reviewed-state integration/discard, broader authenticated acceptance, and measured efficiency remain incomplete.

Preserve these foundations. All designs/defaults below are proposals, not claims of shipped functionality.

Review decision: adopt the architecture with the corrections below. The [agent workflow roadmap](Agent_Workflow_Roadmap.md) is the delivery authority; this document supplies design rationale. Safe integration precedes expanded scheduling and concurrency. Each feature still needs its own implementation, acceptance evidence, and PR.

## 3. Proposed architecture

| Layer | Owns | Must avoid |
| --- | --- | --- |
| Native editor + manager UI | Task cards, streaming display, terminal, diff, approvals | Model calls for rendering, status polling, or opening diffs |
| Deterministic scheduler | Dependency graph, resource reservations, ownership, retries | LLM deciding routine queue transitions |
| Context builder | Small task brief, relevant file/symbol references, checkpoint | Injecting whole repo or every worker transcript |
| Provider adapters | Version/capabilities, session/turn IDs, events, cancellation, usage | Credential mediation, private-history scraping, silent fallback |
| Worktree/environment manager | Base SHA, branch, setup, ports, test DB, process ownership | Treating checkout separation as a sandbox |
| Review/integration queue | Reviewed snapshot identity, validation, serialized integration | Merging stale review or competing writes to target branch |
| Local event/artifact store | Durable state, logs, evidence, usage provenance | Replaying raw logs into prompts automatically |

Use a deterministic state machine:
`queued → preparing → running → validating → ready_for_review → integrating → done`.
Explicit alternate states: `blocked`, `awaiting_permission`, `interrupted`, `failed`.
“Provider turn completed” does not imply “task validated.”

Persist identifiers and ownership before launching work. Reconcile processes/checkouts after crashes; never silently relaunch an uncertain writer. Retain full diagnostics outside model context.

## 4. Token policy

Claude's guidance emphasizes small context, task-specific skills, reduced MCP overhead, appropriate reasoning effort, and preprocessing outside the model. Its displayed API-cost estimate is not a subscription bill. [Cost guidance](https://code.claude.com/docs/en/costs)

Apply these proposed rules:

1. **Brief once:** objective, acceptance checks, allowed scope, constraints, base SHA, relevant paths. Link details; retrieve only when necessary.
2. **Search before reading:** filename/symbol lookup, targeted `rg`, then bounded excerpts. Exclude generated output, dependencies and irrelevant logs. Expand context when evidence is insufficient.
3. **Keep instructions small:** shared invariants always loaded; specialized workflows on demand. Do not put this whole research guide into every agent's startup instructions.
4. **Filter mechanically:** preserve full test logs as artifacts; send exit status, failed cases and relevant stack traces. Mark truncation and provide retrieval paths.
5. **Resume related work:** continue the recorded provider session with the delta. Start a new session for unrelated objectives; cross-provider handoff uses a concise checkpoint, not an assumed transferable transcript.
6. **Compact at useful boundaries:** preserve decisions, constraints, changed paths, unresolved failures and next action. Let providers manage their internal context; Hydra must not rewrite opaque session state.
7. **Route by task risk:** cheaper/lower-effort options for bounded tasks only when configured and measured; deeper reasoning for architecture, unfamiliar failures, concurrency and integration. Never silently override the user's provider/model.
8. **Stop repetition:** detect repeated failing commands or unchanged patches. After a bounded retry budget, return a blocker with evidence; don't loop indefinitely.
9. **Use narrow review:** acceptance criteria + diff + relevant code/test evidence. Add independent model review for consequential changes; avoid full-repo reviews for every small patch.

These rules have different enforcement boundaries:

| Boundary | Proposed control |
| --- | --- |
| Hydra local code | Build the initial brief, filter logs from Hydra-owned validation commands, retain evidence, count submitted turns and scheduler retries, and hold new launches when their configured limits are reached. |
| Supported provider configuration or hooks | Apply model/effort choices, internal iteration limits, or tool policies only after capability validation for that provider version. Show the effective control and report unsupported limits. |
| Advisory instructions | Ask provider-owned loops to search narrowly, avoid repeated failures, and return concise summaries. Hydra cannot guarantee these behaviors or filter the provider's hidden tool results. |

One Hydra-submitted turn may contain many internal model requests and tool executions. UI output truncation does not reduce that context. Do not label a submitted-turn budget as a token cap or silently rewrite provider session state.

Prompt caching reduces repeated input processing cost under model-specific rules; it does not shrink the logical context or make output free. Preserve stable instructions/tool definitions where possible, measure actual cache usage, and account for compaction/cache rebuilds. Do not assume cache sharing across workers/providers or apply raw API cache settings to opaque CLI sessions. [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## 5. Parallelism without runaway spend

Claude documents higher token use and coordination overhead for teams, especially on sequential or same-file tasks. A subagent summary protects its parent's context but the worker still consumes tokens. [Teams](https://code.claude.com/docs/en/agent-teams), [Subagents](https://code.claude.com/docs/en/sub-agents)

**Starting policy:** use one worker for small tasks and retain the specification's default limit of two active managed tasks. Three workers is an opt-in benchmark configuration after integration and provider acceptance pass, not a new default or a measured optimum. The current limit is per window and excludes official-extension sessions; a future scheduler must define wider capacity accounting before claiming a global cap.

- Decompose by deliverable and file ownership. Stabilize shared interfaces first; queue dependent tasks until prerequisites land.
- Give each writer one worktree and exclusive lease. Read-only research/review can use an immutable snapshot without another writable checkout.
- Parallelize independent UI, backend and documentation only after defining their shared contract. Serialize shared schema, lockfile and central-interface changes.
- Count nested provider workers in budgets where observable. If descendants cannot be metered/limited, label accounting incomplete and avoid automatic nested fan-out.
- Bound active workers by provider quota/rate signals, CPU, memory, disk and environment capacity. Back off on rate limits; reserve budget for validation/integration.
- Use event-driven updates. No token-consuming heartbeat prompts or repeated “are you done?” requests.
- Launch multiple implementations of the same task only as an explicit quality experiment; include rejected candidates in cost.
- Scale concurrency only when measured throughput improves without unacceptable rework or quality loss.

## 6. Worktree and integration lifecycle

Git worktrees share repository objects/refs while maintaining separate working directories and indexes. A branch ordinarily cannot be checked out in two worktrees. [Git worktree](https://git-scm.com/docs/git-worktree)

1. Resolve base SHA and integration target; snapshot any intentionally included dirty input explicitly. Hydra's current creation starts at committed HEAD.
2. Create unique branch/worktree outside the main checkout. Acquire task ownership; launch provider with that exact working directory.
3. Run trusted, idempotent setup without an LLM: locked dependencies, task-specific ports, isolated test database/schema and temporary paths. Share package download caches when safe, not mutable dependency/build directories.
4. Enforce filesystem/network policy through provider/OS isolation where supported. Separate checkouts do not isolate secrets, processes, ports or databases.
5. Execute scoped task; record provider identity, turn results, resource usage and test evidence.
6. Stop writers before review. Record base/head SHA plus fingerprints of staged, unstaged and untracked content. Preserve unsaved editor buffers. Require the selected saved changes to be committed, or explicitly commit them through the finish flow; merging a branch does not include uncommitted changes. Recheck that the immutable task commit matches the reviewed selection before validation.
7. Serialize integration per repository. Record the target commit and create a candidate on a temporary branch or detached integration checkout, since the real target may already be checked out in the main workspace. Merge the reviewed task commit into that candidate and run the affected acceptance checks. Retain both tasks and the candidate if conflicts or tests fail; a resolution changes the reviewed state and requires renewed review and validation.
8. Before promotion, recheck the target's owning checkout, branch identity, expected commit, clean saved state, and relevant unsaved buffers. Refuse a changed or dirty target; rebuild and revalidate the candidate when either input changed. Promote the validated candidate by a fast-forward through the owning target checkout, without directly moving a checked-out branch ref behind its index and files. Preserve a rollback reference and persist the candidate, expected target, and operation phase before mutation so restart recovery can reconcile what actually completed without blindly repeating it.
9. Clean up only after successful promotion, preserving recoverable changes and stopping owned processes. Never force-delete unknown dirty work or discard a task simply because its provider turn ended. Implement and test the target rechecks, crash reconciliation, and conflict recovery before advertising safe integration.

## 7. Minimal task contract

```yaml
task: unique-id
goal: one observable outcome
base_sha: immutable-commit
depends_on: []
write_scope: [src/feature/, tests/feature/]
context: [relevant-path-or-symbol]
acceptance: [behavior, test-command]
budget: {max_submitted_turns: 12, max_scheduler_retries: 2}
result: [summary, changed_paths, commit_or_snapshot, tests, blockers]
```

Numbers are proposed starting limits. Submitted turns count Hydra's initial and follow-up requests; scheduler retries count explicit reattempts of a failed preparation or launch step, not internal provider tool retries. Record retry identity and reconcile uncertain launches before retrying. Neither limit bounds internal model iterations or tokens. Scope is a coordination rule unless tool/sandbox enforcement exists. Dollar limits apply only where reliable billing and controls exist; never infer subscription quota from an API-price estimate.

## 8. Implementation order and measurement

| Priority | Extend | Exit evidence |
| --- | --- | --- |
| Prerequisite | Existing adapters/ownership/recovery | Real authenticated Claude/Codex tool, approval, interrupt and resume acceptance before expanded agent execution; no duplicate writer. M4 development can use bounded fixtures meanwhile. |
| P1 | Existing native review → commit and integration | Reviewed saved changes captured in a commit, stale-review and dirty-target rejection, validated candidate promotion, conflict/crash recovery and recoverable cleanup |
| P2 | Scheduler + environment setup | After P1 and provider acceptance: dependency queue, reservations, bounded retries and crash recovery; distinct ports/DBs |
| P3 | Task brief/checkpoint + model/effort and usage controls | Supported effective selections, correct per-turn versus cumulative accounting, known missing usage, smaller prompts with equivalent acceptance. Basic instrumentation can proceed alongside P1 without increasing concurrency. |
| P4 | Optional ACP + retrieval improvements | Capability/version fixtures; better measured interoperability or accepted-work efficiency |

Benchmark a fixed set of small fixes, cross-file features and refactors against single-agent baseline. Repeat runs; keep provider/model/effort and acceptance checks comparable. Measure:

- Accepted tasks and regression rate; human review time and rework.
- End-to-end latency and accepted tasks/hour.
- All-worker input, output, cache-read/write and reasoning usage where exposed; avoid double-counting provider subsets/cumulative events.
- Total API cost per accepted task, including failed/rejected runs; subscription quota only if provider reports it.
- Context size, repeated reads, cache reuse, retries, conflicts and setup failures.

Ship optimizations only when quality holds. No inspected source establishes that one IDE universally uses fewer tokens for equivalent work; Hydra needs its own measurements.
