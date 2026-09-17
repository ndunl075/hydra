# Provider account setup

Open **Hydra: Provider Accounts** from the Command Palette, Hydra Settings, or onboarding. Opening the panel is passive: no provider process, login, account read, or model turn starts until an explicit action.

Hydra uses the user's installed, unmodified tools. It does not bundle provider binaries, implement an OAuth callback, read credential files, store account identities/tokens, or log authentication protocol traffic. Provider credentials remain in provider-owned storage.

## Pinned contracts

- **Codex 0.154.0:** a separate stdio app-server connection uses `initialize`/`initialized`, `account/login/start` with `{type:"chatgpt"}`, `account/login/cancel`, `account/login/completed`, and `account/read` with `refreshToken:false`. The CLI owns the callback. Hydra opens only HTTPS `auth.openai.com` or `chatgpt.com` destinations and keeps the login ID/URL in memory. Successful completion is followed by a public account read; no thread or turn is created. Pending login expires after five minutes. Refresh opens a short-lived connection. Request failure, cancellation, completion, or window shutdown closes the account transport.
- **Claude Code 2.1.270:** `auth login --claudeai` runs in its own visible native terminal. Hydra does not capture terminal output. Close the terminal and explicitly refresh using `auth status --json`; the public `loggedIn`, `authMethod`, and `apiProvider` fields distinguish `claude.ai` with `firstParty` from other authentication modes. Identity, organization, and subscription-type fields are discarded. Unknown schemas fall back to the documented exit status (0 signed in, 1 not signed in) with account type explicitly unverified. No subscription entitlement is inferred. Cancel disposes the owned sign-in terminal.

Missing and different CLI versions receive install/path guidance rather than an unverified connection label. Actions require a trusted local desktop window and refuse handoff windows. Cancel stops local setup; it does not revoke a completed sign-in or log out an existing account. Sign-out remains in the official clients. Status is a point-in-time provider report, not a live subscription or model-access guarantee.

Primary evidence: [Codex app-server authentication](https://developers.openai.com/codex/app-server), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude permitted platform hosting/authentication](https://code.claude.com/docs/en/legal-and-compliance). The account schema dependency subset in `src/core/generated/codex-0.154.0` was copied unmodified from the locally generated pinned schema. Local Claude public login/status help verified the supported commands and subscription flag. A public status probe exposed only field names and the whitelisted mode booleans/strings to development output; no identity, organization, subscription-type, credential, or token values were displayed. No actual sign-in was performed while developing this feature.

## Acceptance and remaining external validation

Fixture tests cover passive construction, public account reads, login/completion, matching login IDs, cancellation during initialization and pending login, failure/retry, destination validation, pinned versions, Claude status interpretation, and actual JSONL transport without model methods. Native smoke opens/reuses the account panel and verifies that provider state remains unchecked and dirty documents survive.

Real browser sign-in success, cancellation during a live OAuth callback, OS keychain behavior, and subscription eligibility still require user-driven acceptance with the pinned providers. Tests neither open a real provider browser nor send authenticated model calls. Native smoke assertions require the built standalone artifact; they are not evidence of completed live authentication.
