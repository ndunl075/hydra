# Auto delegation rollout policy

This policy is a pure, read-only decision over the existing paired Auto-versus-Solo evaluation report and caller-supplied provider-acceptance facts. It returns only `insufficient`, `keep-solo`, or `eligible-for-human-rollout-review`. Its output is advisory: it always records `defaultMode: 'solo'` and never reads or changes `hydra.delegationMode`, starts a provider, submits a turn, or performs a rollout.

An eligible evaluation still requires a complete matching sample count and an eligible pair for every required sample. Missing or partial provider-reported usage returns `insufficient`. A `worse` token-efficiency result, including `faster-but-more-expensive`, returns `keep-solo`; faster completion is not evidence of savings.

Provider acceptance is deliberately separate and provider-specific. Both advertised providers, Claude and Codex, need an explicit `accepted` live-acceptance fact. A missing fact returns `insufficient`; a failed fact returns `keep-solo`. A passing acceptance fact cannot upgrade an evaluation report that is insufficient, incomplete, or already requires Solo.

`eligible-for-human-rollout-review` only identifies evidence that a later human gate may review. It does not establish a default change, live-provider authorization, paid/API authorization, release approval, or measured savings.
