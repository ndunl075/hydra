# Desktop delivery and onboarding

Hydra is its own Windows IDE, as clarified by Nico on 17 September 2026. Its workflow module is built into a branded Code - OSS desktop build; users do not need to install VS Code. A `.vsix` remains a core development artifact. Standalone acceptance passed in PR #11. Replayable onboarding, settings import, provider account setup and the final combined Windows installer have merged after Linux and native checks; see the [acceptance record](Implementation_Status.md#acceptance-record), [standalone build](Standalone_Build.md), [settings import](Settings_Import.md), [onboarding](Onboarding.md), [provider accounts](Provider_Account_Setup.md) and [Windows installer](Windows_Installer.md).

## Installation

- The Windows user-installer pipeline packages the bundled IDE with Hydra's name, isolated identities and existing README logo. Packaging checks require the bundled module/product version to match the current manifest.
- **Create a desktop shortcut** is unchecked on a fresh install. Reinstall remembers task selection; explicit opt-out removes Hydra's prior shortcut. The visible wizard offers launch afterward.
- Disposable Windows CI passed default-off, opt-in, remembered choice, explicit opt-out, uninstall cleanup, and preservation of Hydra preferences/extensions, VS Code/Cursor preferences and unrelated projects at final combined revision `1410251`. These are same-version reinstall tests.
- Distinct-version upgrades, the visible wizard and launch-after-install require separate acceptance. The artifact is unsigned; code signing, release distribution and automatic updates are not configured. Installer tests must not run against a developer's personal installation.
- The [Windows update-channel decision](Desktop_Update_Channel_ADR.md) defines the future signed stable channel, native verification, consent, and recovery boundaries. It does not activate an updater or replace the pending release gates.

## First launch

Onboarding provides welcome, preferences/import, appearance, provider setup and project selection in a reusable tab. Optional steps can be skipped; interrupted and completed setup can be reopened from Settings. Trusted normal desktop launches are eligible for first-run setup; development/test and provider handoff windows are excluded. Opening onboarding or the account panel starts no provider process or model request. Manual visual/keyboard acceptance remains outstanding.

### Import from VS Code or Cursor

Two click actions detect the selected application's user settings, keybindings, and snippets; a folder picker handles custom profiles/portable installations. Preview categories and conflicts before writing. Import into Hydra's isolated profile, merge without silently replacing existing preferences, back up destination files, and support rollback. Leave source files untouched. Handle commented JSON, unknown settings, missing theme/extension dependencies, Windows paths, and malformed files with actionable errors.

Never copy authentication tokens, credential stores, private state databases, provider histories, or extension binaries as part of settings import. Extension recommendations can be listed separately and installed only through supported distribution routes. An unavailable imported theme gets a visible fallback rather than a false successful-import claim.

### Appearance

Dark and light choices apply to the workbench, editor, terminal, and manager together. Both retain the dark green secondary accent. Imported appearance remains in place until the user chooses another theme. In-IDE **Hydra: Open Settings** provides the same appearance choices. Theme changes preserve open/dirty documents, terminals, and task/session state and make zero provider requests. High-contrast themes remain supported.

### Subscription accounts

- **Set up Claude Code**: explicit login runs the unmodified Claude Code 2.1.270 `auth login --claudeai` flow in an owned native terminal. Close it and explicitly refresh public `auth status --json`. Anthropic owns sign-in and credential storage; Hydra does not capture login terminal output or extract/reuse subscription tokens for a custom API client.
- **Connect OpenAI / ChatGPT**: use pinned Codex App Server's supported `account/login/start` with `type: "chatgpt"`; open the provider-returned authentication URL and await matching completion. Codex owns the callback and credentials. Show verified account state, retry, cancellation, and missing-runtime guidance without reading credential files. Keep this authentication lifecycle separate from task creation and model turns.
- Do not claim a connected account based on executable presence or a browser opening. Verify completion through public provider state. Do not silently select API-key billing as a substitute for a subscription. Existing environment/configuration can affect billing; report verified authentication mode where exposed.

The account feature uses installed pinned runtimes, public status and explicit login/refresh/cancel actions. It stores no credentials or account identities. Account-panel fixtures and browser dispatch checks do not demonstrate real sign-in. Live callback cancellation, OS keychain behavior, subscription eligibility and authenticated provider work still require separate acceptance; cancellation stops local setup and does not log out an existing account.

Official sources checked on 17 September 2026: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code authentication](https://code.claude.com/docs/en/authentication), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and [Claude Code product-hosting and credential guidance](https://code.claude.com/docs/en/legal-and-compliance). Anthropic distinguishes running its unmodified binary with each user's own login from third-party subscription-token integration. Provider behavior must also be verified against Hydra's pinned versions.

## Delivery order and gates

1. In-IDE Settings plus dark/light native themes implemented in version 0.8.0 as a separate feature PR; Windows native-host checks passed. Manual visual/accessibility acceptance remains pending.
2. The branded Code - OSS distribution passed standalone native acceptance in PR #11. Each updated bundled runtime retains its own native gate. [Microsoft's distribution and Marketplace guidance](https://code.visualstudio.com/docs/supporting/faq) requires a distinct extension-distribution route for forks; do not assume access to Microsoft Marketplace or redistribute provider extensions without checking their terms.
3. Import preview, merge/backup/rollback and active-profile targeting are implemented; import remains unavailable in the VS Code host. Skippable onboarding and completion persistence merged in PR #18 after Linux/native checks. Preserve those flows in final combined acceptance.
4. Provider-owned account setup, pinned-runtime guidance, public status and cancellation merged in PR #24 after its exact-revision native checks passed. Live-provider acceptance remains outstanding. Login submits no model turn.
5. Installer generation and disposable lifecycle tests merged in PR #19 after final combined revision `1410251` passed native build, smoke and lifecycle checks. Retain separate gates for distinct-version upgrades, visible wizard/launch, signing, distribution and updates.

M6 is complete only with a tested standalone installer and all onboarding gates; extension packaging does not mark it complete. These features ship in individual PRs under Nico's commit, push, review, and merge workflow.
