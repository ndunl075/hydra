# Codex live-acceptance harness

This harness prepares evidence for a human-operated acceptance session using the pinned Codex CLI `0.154.0`. It does not authorize a provider session. A ChatGPT subscription login, any provider turn, and any cost-bearing action require the operator's explicit approval at the time of the run. Hydra must not substitute API-key billing.

## Safe fixture

Run the fixture explicitly:

```powershell
node scripts/codex-acceptance.mjs --fixture --output .test-build/codex-acceptance-fixture.json
```

The output is a local, redacted fixture record. It proves the documented ordering used by the existing adapters:

| Surface | Recorded ordering |
| --- | --- |
| Account refresh | `initialize`, `initialized`, `account/read` |
| ChatGPT login cancellation | `initialize`, `initialized`, `account/login/start`, `account/login/cancel` |
| Explicit quota refresh | `initialize`, `initialized`, `account/rateLimits/read` |

It also records closure of the owned cancelled channel and an unavailable quota result. It contains no account identity, email, plan, API key, balance, reset credit, reset token, browser URL, prompt, or provider output.

Fixture mode records only the account and quota sequences above (Hydra's managed Codex sessions were removed with the task system), and never starts Codex, checks whether an executable exists, opens a browser, signs in, reads credentials, starts or resumes a real thread, submits a turn, or uses API billing. The Windows readiness RPC is required after `initialized` and before `model/list`; non-Windows hosts omit it. If that implementation no longer establishes the exact sequence, the fixture fails with an `Unsupported fixture condition` and withholds evidence rather than guessing a protocol. Neither a browser opening nor executable presence is evidence of sign-in. The fixture's `pending-human-operated-run` state is deliberately not a live acceptance result.

## Human-operated live acceptance

Use a disposable, reviewable worktree and an explicitly bounded task. Before any provider action, record the operator, the approved subscription mode, task scope, and budget authorization outside Hydra's durable task evidence. Do not put account identifiers, reset tokens, URLs, credentials, or billing data into the record.

1. In Hydra, use **Provider accounts** to begin the existing ChatGPT login flow. The operator completes the provider-owned browser login and refreshes the account state. Record only the displayed authentication mode. A successful browser launch is not sign-in proof.
2. Select **Refresh Codex limits** explicitly. Record only the public bucket measurements and observation timestamp. If the provider omits the quota, preserve `unavailable`; do not convert it to zero, infer permission, or use it as model entitlement.

Record a live result as pending unless every selected action was observed and the operator can retain a redacted evidence record. This harness does not establish subscription eligibility, model entitlement, account quota, successful login, live approval behavior beyond the observed case, or rollout readiness. A live result for Codex does not authorize Claude or enable Auto delegation.

## Validation

`tests/codexAcceptance.test.ts` runs the fixture in a temporary directory. It checks exact documented method sequences, redaction sentinel absence, cancellation-channel closure, unavailable quota semantics, explicit opt-in, and refusal to overwrite an existing evidence file. The existing account, managed-Codex, and quota tests remain the authority for their transport behavior.
