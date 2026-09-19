# Delegation event contract

This is the version 1, pure contract for recording facts that the Agent graph may later render. It does not persist events, observe task state, launch a process, submit a provider turn, or derive traffic from a parent/child relationship. Feature 07 owns journal persistence and real host producers.

Every event has a stable 24-character event ID, a positive per-parent-run sequence, UTC timestamp, parent task ID, run ID, explicit endpoints, and provenance. The producer and source record ID state what observed the fact. Graph consumers must only animate a supplied event; a delegation relationship, scheduler state, or provider completion never implies an event.

| Event | Explicit route | Producer | Source record |
| --- | --- | --- | --- |
| `assignment` | parent task -> child task | host | decision record |
| `dispatch` | scheduler -> child task | scheduler | dispatch receipt |
| `result-delivery` | child task -> parent task | host | child-result receipt |
| `validation` | verification -> child task | verification | verification record |
| `approval-pause` | host -> child task | host | approval record |
| `interruption` | scheduler -> child task | scheduler | interruption record |
| `acceptance` | integration -> parent task | integration | integration receipt |

Version 1 is the first persisted event schema. Version 1 is accepted unchanged. Missing, older, newer, or unknown versions are refused rather than guessed or migrated lossily. A future migration must add an explicit converter and tests before widening this rule.

Stored history holds at most 512 canonical events per parent/run. Exact duplicate event IDs with identical content collapse during replay. A repeated ID with different content, duplicate sequence, or malformed provenance is refused. `boundDelegationGraphEventHistory()` is the explicit retention helper for a journal: it canonicalizes, retains the newest entries by sequence, and returns the evicted IDs. It accepts no more than 1,024 incoming entries, so compaction itself remains bounded.
