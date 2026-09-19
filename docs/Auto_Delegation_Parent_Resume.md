# Auto delegation parent resume payload

`createAutoDelegationParentResume(input)` is a pure projection from one saved wakeup and the host-loaded child result records for that same parent/run. Its `ready` payload contains compact, sorted receipt references, child summaries, and explicitly reported unresolved caveats. It does not copy a child log or transcript.

The saved wakeup carries the immutable, nonempty receipt-hash snapshot that caused it and the hash of that snapshot. The function first verifies that saved key, then re-parses exactly those saved receipt records with their immutable bindings. It blocks while any saved snapshot receipt is unavailable; receipts that arrive after the saved wakeup are deliberately excluded so they cannot change its payload or identity. A failed child, stale wakeup key, foreign saved receipt, or malformed input also blocks. A payload that cannot fit its 12 KiB content limit blocks rather than silently dropping required caveats.

The returned `resumeId` is a SHA-256 identity over the version, parent/run, saved wakeup key, sorted saved receipt references, and caveats. Concurrent child completion order therefore does not affect it; replaying a saved input, rebuilding it after restart, or loading later receipts produces the same payload and identity for that saved wakeup.

This module has no journal writes, task/scheduler mutation, provider launch, or model turn. A later host boundary may persist or submit the ready payload only after its existing wakeup, review, and integration gates succeed.
