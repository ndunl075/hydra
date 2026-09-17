# Hydra

A Windows-first VS Code extension for switching between ordinary editing and an agent manager. The product and acceptance gates are in [the project spec](docs/Agent_Manager_Project_Spec.md).

## Available features

- Open **Hydra: Toggle Editor / Agents** from the Command Palette or press **Ctrl+Alt+A**.
- A persistent status-bar control switches modes.
- The manager uses near-black (`#141414`), white text (`#F5F5F5`), and dark green (`#173C2C`). Select **Hydra Dark** through VS Code's color-theme picker to apply it to native surfaces too.
- Returning to Editor restores the previously focused text document, selections, and visible range. The extension does not close text tabs or touch terminal processes.
- Create titled Claude Code or Codex tasks from the manager or **Hydra: New Task**. Each starts at committed HEAD in a unique `agent/…` branch and sibling worktree; dirty main-checkout edits stay in place.
- Open the provider in a native terminal at the exact worktree and use **Copy prompt** to paste the task when ready. Provider authentication, conversation, and permissions stay in the official CLI.
- Search and filter tasks, inspect worktree identity, refresh changed-file inventory, and open existing files in the native editor.
- Stop a terminal explicitly. Task worktrees and branches remain available. Closing the manager or switching modes keeps the task terminals alive.
- Saved records recover after reload. Missing sessions become interrupted, never completed. Hydra stops its owned terminals on extension shutdown and does not promise background survival or automatic CLI resume.

The manager occupies a supported editor tab alongside native editors and terminals. It does not promise exact restoration of arbitrary grid layouts. Structured conversation, model controls, approval handling, resume, usage, native diff review, integration, and discard are subsequent features.

## Provider and worktree settings

Install the official Claude Code and/or Codex CLI separately using its supported login flow. Hydra searches PATH; set **Hydra: Claude Path** or **Hydra: Codex Path** to an absolute executable path if needed. Executable presence does not prove authentication or protocol compatibility. Windows `.cmd` / `.bat` shims are launched through PowerShell with an encoded, quoted executable path; task prompts are never inserted into shell commands.

The default limit is two provider terminals. Extra launches are refused with an explanation; this terminal prototype does not implement the future managed-session queue. Tasks can still be created while that limit is reached. Configure **Hydra: Worktree Root** to choose an absolute directory outside the main repository. No secrets, ignored files, or dependencies are copied automatically.

One Hydra window owns each canonical repository at a time. A second owner displays an error and disables task operations. Records are local under VS Code's extension global-storage directory, with atomic, versioned metadata. Corrupt records are preserved for diagnosis. Worktrees isolate files and indexes; they are not a security sandbox.

## Build and run

Requires Node.js 22 and VS Code 1.95 or newer.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run test:smoke
npm.cmd run package
```

Press **F5** in this repository to launch an Extension Development Host. Alternatively install `hydra-0.2.0.vsix` using **Extensions: Install from VSIX**. No marketplace publishing is required.

`npm.cmd test` runs real-Git safety and storage tests. The smoke test uses installed VS Code on Windows and downloads a host on other platforms. It checks three mode cycles, three isolated tasks in a dirty repository, both provider launch routes with local test executables, exact terminal working directories, duplicate prevention, concurrency, and recovery in a second fresh host. These executables make no model requests and do not validate real-provider protocol capabilities. Linux CI runs the same host tests under Xvfb. Failed fixtures are retained under `.test-build` for diagnosis.
