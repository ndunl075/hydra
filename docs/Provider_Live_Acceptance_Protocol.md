# Provider live-acceptance protocol

`providerReadiness()` is a passive local report over supplied adapter metadata. It never starts a process, login, callback, provider turn, or API request, and it retains no account identity or token.

A report can show an installed adapter, supported `model` and `effort` controls, and a bounded task/evidence template. Authorization remains missing until an operator and budget are supplied explicitly. `ready` is always false: the report does not claim subscription eligibility or authorize a live acceptance run.
