# Hydra

A Windows-first VS Code extension for switching between ordinary editing and an agent manager. The product and acceptance gates are in [the project spec](docs/Agent_Manager_Project_Spec.md).

## Current feature: M0 mode prototype

- Open **Hydra: Toggle Editor / Agents** from the Command Palette or press **Ctrl+Alt+A**.
- A persistent status-bar control switches modes.
- The manager uses near-black (`#141414`), white text (`#F5F5F5`), and dark green (`#173C2C`). Select **Hydra Dark** through VS Code's color-theme picker to apply it to native surfaces too.
- Returning to Editor restores the previously focused text document, selections, and visible range. The extension does not close text tabs or touch terminal processes.

This is the supported layout prototype: the manager occupies an editor tab. It does not replace VS Code's workbench or promise exact restoration of arbitrary grid layouts. Closing its tab returns the status control to Editor. Task creation, provider integration, and review are subsequent features.

## Build and run

Requires Node.js 22 and VS Code 1.95 or newer.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run test:smoke
npm.cmd run package
```

Press **F5** in this repository to launch an Extension Development Host. Alternatively install `hydra-0.1.0.vsix` using **Extensions: Install from VSIX**. No marketplace publishing is required.

The smoke test uses the installed VS Code on Windows and downloads a test host on other platforms. It tests three complete mode cycles with an unsaved buffer, text selection, and an existing live terminal. Linux CI runs it under Xvfb.
