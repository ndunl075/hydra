# Native visual and accessibility acceptance

This is a human-operated acceptance record for a real native Hydra window. It covers Editor/Agents switching, dirty tabs, native terminal ownership, keyboard focus, dark/light/high-contrast appearance, reduced motion, onboarding, and the visible installer wizard.

Create a pending local record:

```powershell
node scripts/native-visual-acceptance.mjs --fixture --output .\native-visual-acceptance.json
```

The generated record is deliberately `human-visual-accessibility-acceptance-pending`. It does not start Hydra, open a window, install an application, modify a profile, authenticate an account, or run a provider turn. It also does not change [native-workflow-acceptance.json](../tests/fixtures/native-workflow-acceptance.json), which remains pending until a real native Hydra window is inspected.

## Human review

Use a fresh standalone Hydra runtime after the normal local build, verification, and smoke gates have passed. Record a concise human observation for every checklist item. Set an item to `passed` only after the stated review succeeds; set it to `failed` when it does not. The installer-wizard review belongs on a disposable Windows host.

Set `nativeHydraWindowInspected` to `true` only for the actual native-window review. A record can have overall status `passed` only when all nine required observations are `passed`, each has a non-empty human observation, and that field is true.

Validate a completed record without changing it:

```powershell
node scripts/native-visual-acceptance.mjs --validate .\native-visual-acceptance.json
```

Validation returns `pending` for incomplete records and rejects an attempted pass when a native-window claim, an observation, or a passing result is missing. It also rejects an attempted pass with a failed keyboard-focus or high-contrast case. Schema validation only checks the recorded claims; it does not replace the human inspection or make a release claim.

This record reuses the local-fixture scope and pending boundary from [Native Workflow Acceptance](Native_Workflow_Acceptance.md). The evidence-artifact rules for other native gates remain in [Native Acceptance Artifact Kit](Native_Acceptance_Kit.md).
