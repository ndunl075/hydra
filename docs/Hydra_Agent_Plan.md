# Continuing when a provider hits its limit (Freebuff research)

Status: **research** (2026-09-24). Follows up the "Later" section of [Settings_And_Connectors_Plan.md](Settings_And_Connectors_Plan.md).

## The idea

When Claude or Codex hits its usage limit, offer **Switch to Hydra Agent**: Hydra's own agent, running on Freebuff, continues the work with an automatic handoff.

## Finding: Freebuff can't be Hydra's engine

Freebuff (freebuff.com, Freebuff, Inc., the free, ad-supported tier of Codebuff) is a free coding agent. It has a CLI (`npm install -g freebuff`), a Desktop app, Web, Cloud and Chat, and uses DeepSeek, GLM, MiMo and MiniMax models. The code is open source (Apache-2.0 at the repo root, MIT for the `freebuff/` folder), but the **free inference** comes with terms that rule out what the idea needs.

From the [Terms of Service](https://freebuff.com/terms-of-service), "Free Access and Human Use" (effective 2026-07-23):

- You may not "use a bot, script, macro, headless browser, autonomous agent, or similar automation to operate our products".
- "A human must initiate each session and remain actively present while it runs."
- You may not reach free inference "except through normal use of an official Company product … directly or through scripts, custom clients, wrappers, integrations, or third-party software."
- Free access "is provided for individual, human-directed use through the normal interfaces", may be ad-supported, and is limited to one account per person.
- Upstream abuse detection can rate-limit or ban accounts. The unofficial "Freebuff2API" proxies on GitHub are exactly what these terms forbid.

So each of these would break the terms and put Nico's account at risk:

- a head whose provider is Freebuff,
- Hydra driving the `freebuff` CLI in the background,
- a Hydra chat backed by Freebuff inference.

The legitimate programmatic route is the **Codebuff SDK** (`@codebuff/sdk`, `new CodebuffClient({ apiKey, cwd })`, `client.run({ agent: 'base', prompt, handleEvent, previousRun })`). It needs a Codebuff API key and is **paid**: 1¢ per credit, or $100–$500/month plans. That makes it a third paid provider, not the free fallback the idea wants.

Other Freebuff facts worth knowing:

- **Regions:** full access only in supported regions. Other regions and VPN users get a limited model set and six one-hour sessions a day.
- **Ads:** ads are personalised from message analysis.
- **Training:** models labelled "May use data for AI training" may train on what you send. Connecting a repo to Freebuff Cloud authorises "codebase evaluation" of it.

## What we can build instead

The useful part of the idea is the handoff: noticing the limit, and continuing without losing context. That can be built without automating Freebuff.

### 1. Detect the limit

| Where | How | Notes |
| --- | --- | --- |
| Claude Code chats (the extension) | A Claude Code `StopFailure` hook with matcher `rate_limit`, in `~/.claude/settings.json` | Hooks from user settings fire in the VS Code extension too. The payload has `error`, `session_id`, `cwd` and `transcript_path`. Hydra already writes a user-level allow rule at Connect, so the hook goes in the same place and is removed byte-exactly on Disconnect. The hook command tells Hydra via its existing local endpoint. The reset time is not in the documented payload. |
| Codex chats | Poll `account/rateLimits/read` over the Codex app-server | Hydra already calls this for **Provider Usage Limits** (`src/core/quota.ts`). `RateLimitSnapshot.rateLimitReachedType` says when a limit is reached. Limits are account-wide, so this covers the extension's chats too. |
| Heads | Hydra runs the CLIs itself | Claude `stream-json` emits `system/api_retry` with `error: "rate_limit"` / `error_status: 429`, then a failed result. Codex reports it through app-server events. |

### 2. Build the handoff without asking a model

The limited provider can't write its own summary, so Hydra assembles one mechanically into `HANDOFF.md` in the worktree:

- **The ask:** the last user messages. For Claude, read from the hook's `transcript_path`. For Codex, read from its session rollout file. For a head, use its brief.
- **What's done:** files the agent touched (from tool calls in the transcript), `git diff --stat`, and the branch plus recent commits.
- **What's left:** the head's progress notes, or the transcript's last assistant plan or to-do list.
- **Open questions:** the agent's last message.

Everything stays local, and Hydra shows the file before anything is sent anywhere.

### 3. Offer where to continue

One notification: *"Claude hit its usage limit. Continue in: Codex · Freebuff · Wait"*.

- **The other provider** (Claude ↔ Codex): fully automatic, because both are official CLIs on Nico's own accounts.
  - For a head: restart it with the other provider on the same worktree and brief, plus `HANDOFF.md`.
  - For a chat: open the other extension's chat. It uses the Chat location mode, and the handoff is copied to the clipboard.
- **Freebuff, human-driven only:** if the user has installed and signed in to Freebuff themselves, Hydra opens a terminal in the worktree running `freebuff`. It copies *"Read HANDOFF.md and continue the task"* to the clipboard for the user to paste. Hydra does not type into Freebuff, read its output, or run it as a head. That's a person using the normal interface, which the terms allow. Freebuff Desktop can also run locally installed Claude Code and Codex agents, but that doesn't help when those are the ones out of quota.
- **Wait:** show the reset time where it's known. For Codex it comes from the rate-limit snapshot; for Claude, parse it from the error text if present.

### 4. Optional later: a paid "Hydra Agent" provider

If a third provider is still wanted, add it as a head provider on `@codebuff/sdk` with the user's own Codebuff API key, stored in VS Code secret storage. It's opt-in and paid, and shown with its cost. Check the SDK's own terms and whether it can use OpenRouter / BYOK models before starting.

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | Limit detection. Claude `StopFailure` hook: install, remove byte-exactly, and show it in Connectors' "What Hydra wrote". Codex polling of `account/rateLimits/read` while a chat is active. Head detection in the runners. Unit tests with recorded payloads. | **Opus** for the hook/settings-safety and endpoint design, **Sonnet** for the rest |
| 2 | Mechanical `HANDOFF.md` builder from transcripts, rollouts, head state and git, with fixture tests. | **Sonnet** |
| 3 | The notification and the Codex / Claude handoff (heads: automatic provider switch; chats: open the other chat plus clipboard). | **Sonnet** |
| 4 | Freebuff hand-off: detect an installed `freebuff`, open a terminal in the worktree, copy the prompt, and a one-time explainer of its ads and training terms. | **Sonnet** |
| 5 (optional) | Codebuff SDK head provider with the user's own API key. | **Opus** to design, **Sonnet** to build |

## Before building

- **Run `freebuff --help` locally.** Check whether it takes a starting prompt or `--cwd`. Even if it does, keep the clipboard flow: a prompt passed in by Hydra starts the session automatically, and the terms want a human to start it.
- **Check Nico's region.** Outside the supported regions, Freebuff drops to the limited model set.
- **Consider asking Freebuff for written permission.** The terms carve out uses with "written consent"; a direct integration could be agreed with them.

## Sources

- [Freebuff Terms of Service](https://freebuff.com/terms-of-service)
- [Freebuff launch post](https://freebuff.com/blog/freebuff-launch)
- [CodebuffAI/freebuff on GitHub](https://github.com/CodebuffAI/freebuff)
- [Freebuff Privacy Policy](https://freebuff.com/privacy-policy)
- [Codebuff SDK docs](https://www.codebuff.com/docs/advanced/sdk)
- [Codebuff pricing](https://www.codebuff.com/pricing)
- Claude Code hooks: [hooks guide (StopFailure)](https://code.claude.com/docs/en/hooks-guide.md), [VS Code extension](https://code.claude.com/docs/en/vs-code.md), [headless / stream-json](https://code.claude.com/docs/en/headless.md)
