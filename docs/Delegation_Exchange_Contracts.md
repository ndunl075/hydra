# Delegation exchange contracts

Feature 02 defines pure, versioned data contracts. It does not persist, send, or automatically satisfy a request, launch a provider, or add any transcript content to a child.

`prepareContextRequest()` accepts a request only when its parent/run/child identity matches the host-supplied binding. Each requested source names a path within that child’s recorded write scope, the source revision and SHA-256 observed by the child, and a short reason. Requests are bounded and deduplicated by source ID and case-insensitive path. `assertFreshContextRequest()` requires the host to compare each requested source to freshly observed revision and digest before delivery. It never reads files itself.

`prepareDelegationResult()` binds a concise result to the recorded parent/run/child, dispatch key, base commit, scope, and dependency receipt digests. A result has exact commit and tree IDs, changed paths within the assigned scope, decisions, validation outcomes, unresolved issues, and pointers to full local evidence. Evidence references contain metadata and SHA-256 digests only; logs and transcripts are excluded. Its dependency list must exactly match the host-recorded dependency binding.

Context request scope is explicit: `readScope` records host-authorized readable paths separately from write ownership. If it is omitted, requests are limited to `writeScope`; a child cannot turn its worktree access into a request for arbitrary repository or conversation history. `parseDelegationContextRequest()` and `assertFreshContextRequest()` re-parse every stored field against that original binding before checking a fingerprint or current source provenance.

Result decisions and summary are single-line text capped at 1,200 characters; each unresolved item is one line capped at 500. Control characters, Markdown fences, transcript-role prefixes, and common terminal/test-log markers are refused. Evidence remains a digest-bearing reference to retained local output. `parseDelegationResultReceipt()` and `assertDelegationResultIntegrity()` re-parse scope, dependency, and evidence structure against host bindings before accepting a fingerprint.

Both receipts include SHA-256 fingerprints over their canonical JSON fields. Feature 07 will persist and deduplicate them, then provide delivery and replay. Consumers must treat integrity, scope, freshness, and dependency failures as blockers.
