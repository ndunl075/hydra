# Delegation result ingress

`DelegationResultIngress` is the host boundary for a completed child's compact result. Its caller supplies the saved child record, a host-loaded durable materialized dispatch receipt, and the binding captured from dispatch; provider completion text is not an input and cannot be treated as acceptance.

Before writing a receipt, ingress requires the binding and durable dispatch receipt to match the child’s saved parent, run, child key, dispatch key, and base commit. A copied child record without that durable receipt is refused. It requires an exact reviewed commit/tree from that base and uses the existing delegated-verification gate, which rejects stale, failed, interrupted, unavailable, or artifact-less required verification.

The compact receipt is parsed against the saved binding and must name that same reviewed commit/tree. Only then is it appended to the orchestration journal. The journal atomically retains one immutable receipt per child key: an exact replay is a no-op, while a different receipt for that child is refused. A journal-save error does not mutate the source child record, so its reviewed work and verification evidence remain recoverable. On restart, replaying the same receipt does not duplicate delivery.

This receipt proves a verified child result only. Parent review and combined integration acceptance remain separate gates.
