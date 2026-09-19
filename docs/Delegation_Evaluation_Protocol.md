# Delegation Evaluation Protocol

This protocol defines the local manifest that will later make an Auto-versus-Solo comparison reviewable. It records a frozen corpus; it does not run tasks, execute the listed commands, create provider sessions, submit turns, read credentials, or change the delegation preference. Solo remains the default.

## Corpus version 1

Each manifest has an exact `version: 1`, an identifier, explicit tolerances, at least one immutable case, and a SHA-256 digest of its canonical JSON fields. Unknown fields are rejected. A case has its own digest and pins:

- a canonical `owner/repository` identity and 40-character base commit;
- the provider, model, and effort used by both modes;
- one or more declared acceptance commands, which the validator only retains as data;
- a named quality metric and its minimum score;
- explicit non-zero submitted-turn and reported-token ceilings; and
- all observations required for a later ledger: acceptance, quality, elapsed time, reported usage, regressions, integration conflicts, and manual rework.

The manifest has no prompt, transcript, artifact log, account identity, token, API key, or credential field. Cases must be recreated when their frozen content changes. A branch, tag, or other moving base is invalid.

## Paired comparison rules

A later evaluation supplies one explicit `auto` run descriptor and one explicit `solo` run descriptor. Both bind to the same corpus ID/SHA-256 and case ID/SHA-256; the validator resolves that exact case from the corpus before a pair is comparable. The descriptor contains no prompt, output, transcript, credential, or result. Its shared immutable case pins repository, base commit, provider, model, effort, acceptance commands, quality threshold, budget ceiling, and all required observations.

The corpus explicitly declares the samples per mode and tolerances for quality regression, usage increase, and elapsed-time increase. It does not decide an outcome. Missing provider usage is still a required observation; a later ledger must label it unavailable or partial, never replace it with zero or a pass.

## Validation boundary

`parseDelegationEvaluationCorpus` and `assertEquivalentEvaluationPair` are pure in-memory validation functions. They do not access the filesystem, inspect Git, launch a command, make network requests, invoke an adapter, or mutate configuration. The JSON fixture under `tests/fixtures/delegation-evaluation/` is a structural example only and has no evaluation results.

Real corpus runs, provider authentication, provider turns, choosing the actual corpus/sample/threshold/budget values, and any decision to change the Auto default remain explicit human and live-acceptance gates.
