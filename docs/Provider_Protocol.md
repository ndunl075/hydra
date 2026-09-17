# Provider protocol evidence

## Claude CLI 2.1.270

Hydra uses the unmodified official executable and preserves its login/environment. Each managed turn sends text through stdin to `-p --output-format stream-json --verbose --include-partial-messages --permission-mode default --permission-prompts none`. A follow-up adds `--resume <recorded-session-id>`; model and credential overrides are absent. Default/manual rules and provider hooks still apply, and unresolved requests are denied. Interactive approval UI and streaming-input control messages are not implemented.

The parser validates `system/init` against version, working directory, permission mode, and UUID session identity. Main-conversation `stream_event` text deltas update the view. A `result` carries final text, session identity, denials, and optional usage/cost. A successful result plus zero exit is required to finish a turn. Unknown events and subagent events remain in raw diagnostics; they are not mixed into the main response. Invalid JSON, duplicate results, incompatible initialization, and lines over 1 MiB fail explicitly. Process-tree termination is a stop operation, not graceful interruption.

| Behavior | Evidence | Limit |
| --- | --- | --- |
| Text streaming | Real CLI 2.1.270 emitted text deltas in a tools-disabled scratch test; production parser replay passed | Normal project customization/tool behavior needs broader acceptance |
| Follow-up/resume | A second real invocation resumed the returned ID and recalled the marker | No automatic resume; interrupted-turn continuation is not fully validated |
| Usage | Both real results included token/cache usage; parser replay passed | Estimates do not establish subscription billing or actual charges |
| Persistence/reload | Actual Windows VS Code hosts recovered response text and session ID | No background survival is promised |
| Stop | Windows fixtures confirm the process and grandchild heartbeat both stop | Forceful process termination; graceful provider interruption unavailable |
| Errors/denials | Fixtures cover malformed streams, missing results, failed exits, identity mismatches, and denial metadata | No custom permission host or real interactive approval validation |
| Ownership/concurrency | Native host tests block overlapping terminal/handoff writers and count managed processes with terminals | Manual external writers remain outside Hydra's control; starts are refused rather than queued |

Sources: [public CLI programmatic usage](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), and [CLI authentication](https://code.claude.com/docs/en/authentication). A custom approval bridge and additional provider versions require separate verification. Hydra neither reads private provider history nor intermediates credentials.

## Codex App Server 0.154.0

Hydra uses the unmodified official executable with `app-server --listen stdio://`. Version-specific TypeScript and JSON schemas were generated from pinned `@openai/codex@0.154.0`; the unmodified request-type dependency closure is checked into `src/core/generated/codex-0.154.0`. The stable initialization explicitly disables experimental APIs and attestation. No external transport/listener is opened, model is overridden, login is intermediated, or provider-private history is read.

Initialization must identify the pinned CLI. Windows startup checks `windowsSandbox/readiness` and refuses missing/outdated setup. `thread/start` / `thread/resume` must return the exact worktree, pinned thread creation version, matching recorded UUID, on-request approvals, and effective workspace-write policy. Thread identity and owning provider are persisted before `turn/start`; no relative path, latest-session selector, or injected history is used. Old 0.5 records retain Claude ownership even after handoff.

Turns supply text input with `text_elements: []`, exact worktree, on-request approval policy, and `sandboxPolicy` workspaceWrite with only the task worktree as an additional writable root, network disabled, and both temporary-directory write exclusions enabled. Root-thread/current-turn deltas update messages, authoritative completed message items replace deltas, and `tokenUsage.last` supplies per-turn token/cache figures. Other threads' output is excluded from the visible response but retained raw. Matching `turn/completed` and zero process exit are required; failures, interruptions, invalid JSON, identity mismatch, missing finals, and unclean exits never become success.

Command, file, and network approval cards retain full request parameters and are bound to the current thread, turn, process, and server request ID. Responses offer only `accept` / `decline`; no amendments or session-wide grants. Resolved/completed/interrupted requests disappear, cannot be replayed, and are never persisted as actionable approvals. Unsupported requests receive an RPC error and stop the turn without granting permission. `turn/interrupt` targets the actual root turn; bounded cancellation and process close waits fall back to terminating the owned tree.

| Behavior | Evidence | Limit |
| --- | --- | --- |
| Generated schema / stable initialization | Real pinned Windows CLI generated both schemas and returned matching initialization identity | Does not prove login or model/tool behavior |
| Windows sandbox | Real isolated home returned read-only instead of requested editing policy. Production adapter then replayed the real initialization/readiness path and rejected `notConfigured`; raw sent methods contained no `turn/start` | No system setup was run. Editing requires official-client sandbox setup; authenticated acceptance pending |
| Streaming / usage / resume | Local process fixtures and actual Windows VS Code hosts validate root output, final text, token metadata, and explicit thread-ID resume | Real authenticated Codex model/tool test remains pending |
| Approvals | Fixtures/host verify command, network, file, accept/decline, stale-response rejection, and reload cleanup | Generic permissions, user input, MCP elicitation, and auth-token refresh are intentionally unsupported |
| Interrupt / fallback | Fixtures and native host target active thread/turn; Windows descendant heartbeat stops on failed interrupt fallback | Real tools-running interruption/resume acceptance pending |
| Storage / ownership | Local raw stdin/stdout/stderr logs and atomic history; native host blocks overlapping writers and shares terminal concurrency | No queue, automatic resume, or external background survival promised |

The [official App Server contract](https://learn.chatgpt.com/docs/app-server) and [Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox) are the public integration sources. Terminal and official-extension routes remain available for other CLI versions and unsupported flows. This is a pinned structured foundation, not completion of M3.
