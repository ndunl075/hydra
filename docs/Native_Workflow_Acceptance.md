# Native workflow acceptance

Feature 33 adds a bounded local fixture record for the Hydra workflow. It covers Editor/Agents switching, selected agent-workspace identity, context and result inspection, reported-budget labels, keyboard focus, high contrast, and reduced motion. The record is [native-workflow-acceptance.json](../tests/fixtures/native-workflow-acceptance.json).

Run the fixture with the normal local suite:

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd test
npm.cmd run test:smoke
```

`test:smoke` uses local fixture provider shims only. It does not run a provider turn, sign in, install anything, or claim a release acceptance result. `npm.cmd run desktop:smoke` may run the same host assertions against a previously built local Hydra executable.

The machine-readable record deliberately remains `human-visual-accessibility-acceptance-pending`. A person still needs to inspect a native Hydra window with keyboard-only navigation, high-contrast appearance, and reduced-motion settings. Passing the fixture proves that the named contracts are present and exercised locally; it does not replace that visual/accessibility gate.
