# Hydra onboarding

The local Hydra desktop opens a skippable setup on the first trusted, normal launch. Development/test hosts and provider handoff windows do not auto-open it. The owned workbench reports its development/test status, so this also covers the built-in Hydra module running alongside a separate extension-test harness.

Welcome, preferences, appearance, provider guidance, and project selection share a keyboard-accessible tab. Closing it preserves the current step. **Set up later** suppresses automatic reopening; **Hydra: Open Onboarding** or **Settings → Open onboarding** resumes setup. Completed setup can be revisited. Progress is versioned in Hydra's extension global state; it is not synchronized or imported from another editor.

The preferences step uses the same SettingsImport instance as Settings: source detection/picker, active-profile preview, category selection, conflict preservation, exclusions, backup, dirty-file refusal, and undo/recovery. An interrupted import shows the recovery action. Reopening starts with a fresh preview rather than replaying an old write. Appearance changes only on an explicit Dark/Light choice; continuing preserves the current or imported theme.

Provider guidance links to the official Claude Code and Codex instructions. This milestone does **not** implement integrated account connection or report verified connection status. Hydra sends no model requests, reads no credential files, and starts no login process when onboarding opens. A later account milestone must add the pinned public status and cancellation contracts before presenting connected states. The existing generated Codex protocol subset does not yet include those account contracts; that is implementation work, not a claim that upstream lacks authentication support.

Opening a project uses the native folder picker and saves completion before switching windows. Cancelling the picker keeps setup open. No task is created automatically.

Validation: persisted-state and startup-gate regressions; existing import/appearance tests; native desktop smoke assertions for test-host suppression, one-tab reuse, reopen, and preserved dirty documents. Full Windows native CI and manual visual/keyboard acceptance remain required before release. Installer delivery and authenticated provider acceptance are separate milestones.
