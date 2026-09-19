# Delegation evaluation report

Feature 14 is a pure, read-only report over a sealed corpus and immutable local ledger records. It returns only `insufficient`, `keep-solo`, or `eligible-for-human-rollout-review`. It never changes the Auto preference, starts a provider, reads artifacts, or predicts savings.

The report accepts only exact Auto/Solo pairs bound to the same sealed corpus case. It requires the corpus's predeclared sample count and tolerances. Missing or partial reported usage remains visible and prevents a token-efficiency conclusion. Missing elapsed-time evidence is `insufficient`; Auto elapsed time above the declared tolerance returns `keep-solo`. Any Auto quality regression below the case threshold or beyond the declared Solo tolerance also returns `keep-solo`. Faster Auto results that exceed the token tolerance are labelled `faster-but-more-expensive`, not treated as savings.

`eligible-for-human-rollout-review` is evidence for a later human gate only; it is not a rollout action.
