# Delegation result ingress

`DelegationResultIngress` is the host boundary for a completed child's compact result. Its caller supplies the saved child record, a host-loaded durable materialized dispatch receipt, and the binding captured from dispatch; provider completion text is not an input and cannot be treated as acceptance.

Before writing a receipt, ingress requires the binding and durable dispatch receipt to match the child’s saved parent, run, child key, dispatch key, and base commit. A copied child record without that durable receipt is refused. It requires an exact reviewed commit/tree from that base and uses the existing delegated-verification gate, which rejects stale, failed, interrupted, unavailable, or artifact-less required verification.

The compact receipt is parsed against the saved binding and must name that same reviewed commit/tree. Its `validations` and `evidence` arrays must be empty: the existing host verification record proves the gate but does not store artifact SHA-256 digests, so the host cannot attest caller-provided validation or artifact references. Future host-derived evidence binding can add those claims. Only then is the receipt appended to the orchestration journal. The journal atomically retains one immutable receipt per child key: an exact replay is a no-op, while a different receipt for that child is refused. A journal-save error does not mutate the source child record, so its reviewed work and verification evidence remain recoverable. On restart, replaying the same receipt does not duplicate delivery.

This receipt proves a verified child result only. Parent review and combined integration acceptance remain separate gates.

`hydra.receiveDelegationResult` routes through `DelegationIngressHost`. It accepts an opaque result and child task ID, then derives the durable child/run binding, write scope, materialized dispatch, and dependency receipt hashes from saved host records. It does not accept provider identity, dispatch, reviewed tree, verification, or dependency facts from the caller.
