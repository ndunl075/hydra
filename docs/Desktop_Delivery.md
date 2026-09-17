# Desktop delivery and onboarding

Hydra is its own Windows IDE, as clarified by Nico on 17 September 2026. The extension prototype becomes a built-in module of a branded Code - OSS desktop build, not a requirement to install VS Code. A `.vsix` remains a core development artifact. No standalone installer, settings importer, or account-onboarding UI is shipped yet. See [Standalone build](Standalone_Build.md) for the first desktop target.

## Installation

- Deliver a Windows setup executable for the bundled IDE, with Hydra's name and the existing README logo as the application icon.
- Include a **Create a desktop shortcut** checkbox, unchecked by default. Honor both choices during install and upgrade; no shortcut is created now by the extension.
- Offer launch after installation. Use isolated Hydra user-data and extension directories. Installing, upgrading, or uninstalling Hydra must not modify VS Code or Cursor installations.
- Preserve user projects and local preferences during upgrades. Test install/uninstall and shortcut behavior in disposable Windows environments before release.

## First launch

Provide a focused, keyboard-accessible onboarding flow: welcome, import, appearance, accounts, then open a project. Each optional step can be skipped. Save completed/skip state, recover interrupted setup, and let users reopen onboarding from Settings. Installing or opening onboarding never submits a model request.

### Import from VS Code or Cursor

Two click actions detect the selected application's user settings, keybindings, and snippets; a folder picker handles custom profiles/portable installations. Preview categories and conflicts before writing. Import into Hydra's isolated profile, merge without silently replacing existing preferences, back up destination files, and support rollback. Leave source files untouched. Handle commented JSON, unknown settings, missing theme/extension dependencies, Windows paths, and malformed files with actionable errors.

Never copy authentication tokens, credential stores, private state databases, provider histories, or extension binaries as part of settings import. Extension recommendations can be listed separately and installed only through supported distribution routes. An unavailable imported theme gets a visible fallback rather than a false successful-import claim.

### Appearance

Dark and light choices apply to the workbench, editor, terminal, and manager together. Both retain the dark green secondary accent. Imported appearance remains in place until the user chooses another theme. In-IDE **Hydra: Open Settings** provides the same appearance choices. Theme changes preserve open/dirty documents, terminals, and task/session state and make zero provider requests. High-contrast themes remain supported.

### Subscription accounts

- **Set up Claude Code**: invoke the unmodified official Claude Code's supported `auth login` flow. Anthropic owns sign-in and token storage; check supported `auth status` after completion. Users choose their own subscription account in the provider's flow. Hydra does not implement Claude.ai OAuth or extract/reuse subscription tokens for a custom API client.
- **Connect OpenAI / ChatGPT**: use pinned Codex App Server's supported `account/login/start` with `type: "chatgpt"`; open the provider-returned authentication URL and await matching completion. Codex owns the callback and credentials. Show verified account state, retry, cancellation, and missing-runtime guidance without reading credential files. Keep this authentication lifecycle separate from task creation and model turns.
- Do not claim a connected account based on executable presence or a browser opening. Verify completion through public provider state. Do not silently select API-key billing as a substitute for a subscription. Existing environment/configuration can affect billing; report verified authentication mode where exposed.

Official sources checked on 17 September 2026: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code authentication](https://code.claude.com/docs/en/authentication), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and [Claude Code product-hosting and credential guidance](https://code.claude.com/docs/en/legal-and-compliance). Anthropic distinguishes running its unmodified binary with each user's own login from third-party subscription-token integration. Provider behavior must also be verified against Hydra's pinned versions.

## Delivery order and gates

1. In-IDE Settings plus dark/light native themes implemented in version 0.8.0 as a separate feature PR; Windows native-host checks passed. Manual visual/accessibility acceptance remains pending.
2. Build and test Hydra's branded Code - OSS desktop distribution with isolated profiles and the existing workflow built in. This is the immediate priority following Nico's correction. A tested Windows executable is required before calling this gate complete. [Microsoft's distribution and Marketplace guidance](https://code.visualstudio.com/docs/supporting/faq) requires a distinct extension-distribution route for forks; do not assume access to Microsoft Marketplace or redistribute provider extensions without checking their terms.
3. Implement import preview, merge/backup/rollback, and onboarding persistence against Hydra's isolated profile. Keep import unavailable in the host extension; importing Cursor preferences into somebody's active VS Code profile is not the product behavior.
4. Implement supported account setup, runtime availability, public status, cancellation, and real-provider acceptance without model calls on login.
5. Bundle the tested desktop build into the Windows installer with the optional shortcut and first-run launch. Validate updates, uninstall, data preservation, both shortcut choices, and onboarding in clean environments.

M6 is complete only with a tested standalone installer and all onboarding gates; extension packaging does not mark it complete. These features ship in individual PRs under Nico's commit, push, review, and merge workflow.
