# Hydra onboarding

The local Hydra desktop opens a skippable setup on the first trusted, normal launch. Development/test hosts and provider handoff windows do not auto-open it. The owned workbench reports its development/test status, so this also covers the built-in Hydra module running alongside a separate extension-test harness.

Welcome, preferences, appearance, provider guidance, and project selection share a keyboard-accessible tab. Closing it preserves the current step. **Set up later** suppresses automatic reopening; **Hydra: Open Onboarding** or **Settings → Open onboarding** resumes setup. Completed setup can be revisited. Progress is versioned in Hydra's extension global state; it is not synchronized or imported from another editor.

The preferences step uses the same SettingsImport instance as Settings: source detection/picker, active-profile preview, category selection, conflict preservation, exclusions, backup, dirty-file refusal, and undo/recovery. An interrupted import shows the recovery action. Reopening starts with a fresh preview rather than replaying an old write. Appearance changes only on an explicit Dark/Light choice; continuing preserves the current or imported theme.

Provider setup opens the shared account panel from onboarding or Settings. It offers explicit sign-in, public status refresh, cancellation, and retry through pinned provider-owned auth contracts. See [Provider Account Setup](Provider_Account_Setup.md) for exact ownership and acceptance limits. Opening onboarding or the account panel sends no model requests, reads no credential files, and starts no provider process.

Opening a project uses the native folder picker and saves completion before switching windows. Cancelling the picker keeps setup open. No task is created automatically.

Validation: persisted-state and startup-gate regressions; existing import/appearance tests; native desktop smoke assertions for test-host suppression, one-tab reuse, reopen, and preserved dirty documents. PR #18 passed Linux and [Windows native acceptance](https://github.com/ndunl075/hydra/actions/runs/35285172719) at `9722ae5`. Manual visual/keyboard and authenticated provider acceptance remain outstanding. See the [combined acceptance record](Implementation_Status.md#acceptance-record) for later bundled revisions.
