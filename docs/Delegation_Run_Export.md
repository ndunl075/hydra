# Delegated run archive export

`Hydra: Export Delegated Run Archive` copies a bounded JSON archive for the selected delegated child, or for a parent that has exactly one delegated run. Clipboard writing is the command's only side effect. It only reads durable local task, dispatch, journal, boundary, and reconciliation facts; it does not start a process, contact a provider, run a scheduler action, upload data, or import an archive.

The archive has a versioned schema and canonical SHA-256 hash. It contains allowlisted identifiers, task state, reviewed commit/tree receipts, boundary evidence hashes, recovery markers, and evaluation-evidence references. It deliberately excludes prompts, task titles, handoff text, provider/session data, transcripts, commands, raw logs, and artifact contents. Malformed, corrupted, cyclic, duplicate, or oversized archives are refused; import is unsupported.

Hydra does not yet configure or own a corpus-scoped `DelegationEvaluationLedger`, so the command records `evaluationEvidence.availability` as `unavailable` with no references. The core archive API accepts only sealed `{ id, sha256 }` observation references when a future host integration (Feature 31) supplies a validated ledger/corpus binding. It never searches arbitrary files or fabricates ledger observations.
