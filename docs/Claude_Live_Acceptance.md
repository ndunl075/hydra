# Claude live-acceptance harness

This is an opt-in, local evidence runner for the pinned Claude Code `2.1.270` adapter. It prepares a reviewable acceptance record; it does not make a live-provider acceptance claim.

The runner invokes only the documented `--version` command. It does not invoke `auth status --json`: that account-status contract is not documented for the pinned public CLI. It retains only the pinned-version match result and no provider output. In particular, it does not retain email, organization, subscription type, token, credential, account identity, or CLI stderr. It never runs `auth login`, reads a credential store, submits `-p`, passes a prompt, or substitutes API-key billing.

## Fixture proof

Run this first with a local test double. It proves that the documented version probe is the only command, no user turn is submitted, cancellation occurs before any managed turn, evidence is create-only, and the evidence document matches `hydra-claude-live-acceptance/v1`.

```powershell
npm.cmd run check
npm.cmd run build
node --test .test-build/claudeAcceptance.test.cjs
```

The fixture test is not a sign-in, entitlement, model, approval, interrupt, restart, or resume result.

## Human-operated live run

Use an empty disposable worktree and an explicit evidence path. The operator must first complete any provider-owned Claude.ai subscription sign-in in the official Claude client, then run:

```powershell
node scripts/claude-acceptance.mjs --live --executable "C:\path\to\claude.cmd" --evidence .preview\claude-live-evidence.json
```

The resulting live record deliberately remains `pending-human-operated-account-and-managed-turn`. This runner does not establish account status, subscription entitlement, or model access. Account status and the bounded managed-turn acceptance are human-operated Wave C gates through Hydra's existing provider integration. The operator must separately complete the provider-owned Claude.ai sign-in in the official client and explicitly authorize one bounded managed task in Hydra. Before submitting it, record the task worktree, selected advertised model and effort, and the allowed scope. During that one task, confirm one command or file approval through Hydra, stop the owned managed process, restart Hydra, and resume only the recorded provider session. Save the resulting managed-session evidence separately; do not paste transcripts, account output, credentials, or billing data into this record.

Use `--cancel-after-version` to exercise the runner's local cancellation path. It does not sign out or revoke provider state. Evidence creation fails when the target already exists; choose a new evidence path for every run.

Completion stays pending until the human-operated Wave C account check and bounded managed turn both succeed. It also stays pending if the model/effort acknowledgement differs from the selected values, approval scope differs, interruption leaves ownership uncertain, resume is not the recorded session, or the bounded turn was not explicitly authorized. API-key, Bedrock, and any other authentication mode do not establish Claude.ai subscription acceptance.
