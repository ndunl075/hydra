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

## Codex

Public help/version diagnostics are available. Managed App Server sessions are pending. The adapter must pin a CLI version and validate its generated schema, initialization, turns, approvals, stop, and resume before advertising those capabilities. The [official App Server contract](https://learn.chatgpt.com/docs/app-server) is the integration source; terminal and official-extension routes remain available.
