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
| New managed turn with a selection | `initialize`, `initialized`, `windowsSandbox/readiness` on Windows, `model/list`, `thread/start`, `turn/start` |
| Managed resume with a selection | `initialize`, `initialized`, `windowsSandbox/readiness` on Windows, `model/list`, `thread/resume`, `turn/start` |

It also records one declined command-approval request, a `turn/interrupt`, closure of the owned cancelled channel, and an unavailable quota result. It contains no account identity, email, plan, API key, balance, reset credit, reset token, browser URL, prompt, or provider output.

Fixture mode reads the pinned `managedCodex.ts` and model-catalog implementation to establish these two managed sequences, but never starts Codex, checks whether an executable exists, opens a browser, signs in, reads credentials, starts or resumes a real thread, submits a turn, or uses API billing. The Windows readiness RPC is required after `initialized` and before `model/list`; non-Windows hosts omit it. If that implementation no longer establishes the exact sequence, the fixture fails with an `Unsupported fixture condition` and withholds evidence rather than guessing a protocol. Neither a browser opening nor executable presence is evidence of sign-in. The fixture's `pending-human-operated-run` state is deliberately not a live acceptance result.

## Human-operated live acceptance

Use a disposable, reviewable worktree and an explicitly bounded task. Before any provider action, record the operator, the approved subscription mode, task scope, and budget authorization outside Hydra's durable task evidence. Do not put account identifiers, reset tokens, URLs, credentials, or billing data into the record.

1. In Hydra, use **Provider accounts** to begin the existing ChatGPT login flow. The operator completes the provider-owned browser login and refreshes the account state. Record only the displayed authentication mode. A successful browser launch is not sign-in proof.
2. Choose an advertised Codex model and effort, start the bounded task, and verify that the acknowledged effective settings match the chosen values before the first provider turn. Stop if the catalog or acknowledgement is unavailable.
3. Permit exactly one intentionally harmless, scoped command or file approval, then record the visible approval type and decision without copying command details that could be sensitive. Do not grant unrelated approvals.
4. Interrupt the active turn. Confirm the managed channel closes and inspect the worktree before starting anything else.
5. Restart the bounded task and resume the recorded thread only after inspecting its worktree and session ownership. Confirm the provider acknowledges the resumed thread and effective selection before another turn.
6. Select **Refresh Codex limits** explicitly. Record only the public bucket measurements and observation timestamp. If the provider omits the quota, preserve `unavailable`; do not convert it to zero, infer permission, or use it as model entitlement.

Record a live result as pending unless every selected action was observed and the operator can retain a redacted evidence record. This harness does not establish subscription eligibility, model entitlement, account quota, successful login, live approval behavior beyond the observed case, or rollout readiness. A live result for Codex does not authorize Claude or enable Auto delegation.

## Validation

`tests/codexAcceptance.test.ts` runs the fixture in a temporary directory. It checks exact documented method sequences, redaction sentinel absence, cancellation-channel closure, unavailable quota semantics, explicit opt-in, and refusal to overwrite an existing evidence file. The existing account, managed-Codex, and quota tests remain the authority for their transport behavior.
