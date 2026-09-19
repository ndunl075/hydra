# Delegation evaluation ledger

Feature 13 stores explicitly supplied, local observation records for the immutable Auto/Solo corpus. It does not start a task, query a provider, read an artifact, calculate provider usage, or choose a rollout decision.

Every record is versioned and SHA-256 sealed. It binds a pair ID and run ID to the exact corpus ID/SHA, case ID/SHA, mode, and the already-pinned provider/model/effort. The record retains only bounded values and artifact `label`, relative reference, and SHA-256. Logs, transcripts, prompts, credentials, account identifiers, and artifact contents are rejected by the exact schema.

`DelegationEvaluationLedger.append` is append-only. Replaying the exact run record is a no-op; a different sealed record for the same run ID fails closed. The JSON replacement is atomic. Loading validates all records against the supplied corpus, so a changed corpus, malformed disk record, duplicate run, or incompatible pair remains blocked and is never repaired or inferred.

The projection labels each pair incomplete until both modes are present. Reported usage remains `available`, `partial`, or `unavailable`; missing usage is never treated as zero. Quality is unavailable unless each supplied record includes it. The ledger reports observations only and does not produce a rollout decision.
