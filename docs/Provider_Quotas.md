# Provider usage limits

In the local Hydra desktop IDE, open **Hydra: Provider Usage Limits** from the Command Palette, or **Provider usage limits** in a task's reported usage panel. Opening or reopening the page is passive and reuses one tab. **Refresh Codex limits** explicitly reads account limits; it does not start a task, submit a prompt, sign in, purchase credits, or redeem a reset.

## Codex / ChatGPT

The installed official Codex CLI must report the tested stable version **0.154.0**. Hydra checks its version, initializes a separate App Server channel with experimental APIs disabled, then calls `account/rateLimits/read`. The channel accepts only initialization and that read method. Other CLI versions, missing executables, unsupported responses and unavailable authentication produce guidance rather than guessed limits or API-key fallback.

Hydra displays the provider's primary and secondary windows for each reported bucket: used and remaining percentages, duration and reset time when available. Remaining percentage is `100 - usedPercent`, clamped to 0–100. Reset times use the device's local time zone. The multi-bucket map takes precedence over the legacy single bucket, including when the map is empty. Missing windows and metadata stay unavailable. Ordinary included usage permission is shown only when the provider explicitly reports it; quota percentages and elapsed reset times do not establish permission or model entitlement.

Observations have a fetch timestamp and remain in memory for this Hydra window. A failed or cancelled refresh marks retained observations as potentially stale. Provider path or handoff configuration changes clear observations, and restart returns to unchecked. Refresh is available only in a trusted local Hydra window and deduplicates concurrent requests. Cancellation and timeout close the owned read channel; they do not change sign-in or limits. Provider output is bounded and private error payloads are not displayed.

Only bucket labels, window measurements, the observation timestamp and the explicit ordinary-usage permission are retained. Account identities, plan details, credit balances, reset tokens, purchase banners and billing controls are excluded. These account limits are shared across clients and are separate from Hydra's durable task/project usage and soft budgets. Refresh does not release budget-held work or change task/session records.

## Claude Code

Claude subscription limits remain unavailable in Hydra because no verified read-only CLI contract is implemented. The page directs users to `/usage` in the official interactive Claude Code client. Recorded API cost estimates are neither subscription bills nor remaining allowance. No scraping or model request is used to infer limits.

## Verification and remaining gates

The local candidate passed type checking, build, packaging and all 107 tests. Tests cover authoritative buckets, missing fields, malformed/bounded responses, identity/billing stripping, exact-version refusal, cancellation and timeout, and the actual JSONL channel's mutation refusal. Four bundled native fixture hosts passed lifecycle/quota refresh, restart and both handoffs. Native refresh preserved held task/session records and sent no model request; opening was passive, tabs reused, configuration changes cleared observations, and unsupported paths failed safely. Browser checks passed dark/light rendering, explicit refresh/cancel, unavailable fields, timestamps, stale observations and text-only rendering of malicious bucket labels, with no browser errors. Live signed-in quota acceptance, broader provider/version support and Claude's verified limit contract remain outstanding. Full Linux and compiled Windows app/installer CI must pass at the exact feature head before merge.

Official contracts: [Codex App Server account rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt), [Claude Code plan usage guidance](https://code.claude.com/docs/en/costs).
