<p align="center">
  <img src="./hydra-logo.png" alt="Hydra — three-headed hydra logo" width="220" />
</p>

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
- Hand off an idle or stopped task with **Open in Claude Code** or **Open in Codex**. A generated `.code-workspace` opens in a separate window with only that exact checkout, the local task prompt, and the official extension recommendation.
- Run **Check Claude Code / Codex** in the manager to inspect the configured CLI version and public help, or use **Hydra: Check Default Provider Capabilities**. **View diagnostics** opens the captured arguments, stdout, stderr, and exit status locally.
- **Start managed Claude** streams a task through verified Claude CLI 2.1.270. Follow-ups resume its explicit session ID. Responses, raw events, and provider-reported usage are saved locally; **Stop process** terminates the owned process tree and leaves the turn interrupted.
- Saved records recover after reload. Missing sessions become interrupted, never completed. Hydra stops its owned terminals on extension shutdown and does not promise background survival or automatic CLI resume.

The manager occupies a supported editor tab alongside native editors and terminals. It does not promise exact restoration of arbitrary grid layouts. Codex structured sessions, model controls, interactive approvals, native diff review, integration, and discard are subsequent features.

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

Press **F5** in this repository to launch an Extension Development Host. Alternatively install `hydra-0.5.0.vsix` using **Extensions: Install from VSIX**. No marketplace publishing is required.

`npm.cmd test` runs real-Git safety, storage, and handoff ownership tests. The smoke test uses installed VS Code on Windows and downloads a host on other platforms. It checks three mode cycles, three isolated tasks in a dirty repository, both provider launch routes with local test executables, exact terminal working directories, duplicate prevention, concurrency, and recovery in a second fresh host. Two additional hosts load the actual generated Claude and Codex workspace files, validate checkout identity, and test the missing-extension fallback. These executables make no model requests and do not validate authenticated provider sessions. Linux CI runs the same host tests under Xvfb. Failed fixtures are retained under `.test-build` for diagnosis.

## Official extension handoff

The target window opens Hydra's handoff instructions without launching a provider or submitting a prompt. Select **Open Claude Code** or **Open Codex** there to invoke the provider's public UI command; select **Copy task prompt** and paste it yourself. The official extension owns login, conversation, permissions, and session history. CLI installation is not required for this route. Missing or disabled extensions show an installation search; an unsupported command shows the documented Command Palette fallback.

Hydra marks the task externally owned before opening the window. It blocks another handoff or CLI writer while ownership remains external, including after reload or an ambiguous window-opening failure. Hydra cannot observe or stop the external provider. Stop its session in the target window, then select **I stopped the external session** in the original Hydra window to return ownership. This is your acknowledgment, not an automated stop check. Close the old target window before starting another session; Hydra cannot prevent you from manually reopening a provider or running a CLI outside its controls.

No transcript or history is copied. Use history controls in the official provider; no automatic CLI-to-extension resume is claimed. Claude documents shared history and `claude --resume`, but authenticated worktree/session matching still requires acceptance testing. Codex history transfer is not asserted. No private extension data, credentials, or unsupported session APIs are accessed.

The bridge uses `claude-vscode.editor.open` from the public Claude Code extension manifest (checked against version 2.1.269) and the documented Codex `chatgpt.openSidebar` command. It checks the installed extension's public command contribution and registration before invoking it. See [Claude's VS Code guide](https://code.claude.com/docs/en/vs-code), [Codex's IDE guide](https://learn.chatgpt.com/docs/codex/ide), and [Codex command documentation](https://learn.chatgpt.com/docs/developer-commands?surface=ide). End-to-end authenticated provider/history and manual visual checks remain pending; the milestone is a handoff foundation.

## Provider diagnostics

Checks are explicit, never triggered by mode changes, task creation, startup, or refresh. They run only `--version`, `--help`, and (for Codex) `app-server --help`, with an eight-second limit per call and a combined 256 KiB stdout/stderr limit. Timeout, cancellation, and excess output terminate the owned probe process tree. No task prompt, authentication request, session, or model request is sent.

The manager distinguishes help-advertised options from verified adapter capabilities. Recognizing a version or option does not prove authentication, account billing, streaming compatibility, or resume support. Unknown output and failed probes remain actionable diagnostics; the interactive terminal stays available. Checks reset on Hydra configuration changes or reload. Managed Claude supports only the separately verified version below. Codex will use its [documented App Server protocol](https://learn.chatgpt.com/docs/app-server), with version-specific schema validation, in its adapter feature.

## Managed Claude sessions

Claude CLI 2.1.270 is the tested contract; other versions retain the terminal route. Hydra rechecks the configured binary before each turn. Select **Start managed Claude** to send the task prompt, then type and send follow-ups after the current process has ended. Each turn uses `claude -p` with streamed JSON and the exact worktree as its working directory. Follow-ups use only the recorded `--resume` session ID. No live steering or automatic resume is claimed.

The CLI retains its existing authentication and environment. Hydra does not collect credentials, set a model, or bypass permissions. It selects default/manual permissions and denies unresolved prompts with `--permission-prompts none`; provider permission rules and hooks still apply. Denials are shown, and the terminal remains available for work needing interactive approvals. Existing API-key environment variables can affect the CLI's billing route; subscription billing is not asserted.

A finished model turn leaves the task idle for follow-up, rather than claiming the code task is reviewed or integrated. A valid final result and successful exit are both required. Missing results, invalid JSON, worktree/session/version mismatches, and nonzero exits are failures with retained diagnostics. **Stop process** forcibly terminates the owned tree; it is not graceful protocol interruption. Check the checkout before resuming interrupted work, because provider history may omit unfinished output.

Owned session storage contains atomic conversation snapshots and sequenced append-only raw event logs. Reload recovers text and session IDs, marks unfinished turns interrupted, and never sends a model request automatically. The view shows ten recent turns and up to 50,000 response characters per turn, with visible truncation notices; full local output is retained. A 32 MiB per-turn output guard stops excessive output with an error. Token figures are provider-reported, and dollar figures are provider estimates, not an asserted bill or savings percentage.

Managed processes and terminal writers share the configured concurrency cap; extra starts are refused rather than queued. An active managed writer blocks terminal launch and extension handoff for that task. Mode changes preserve running processes; extension shutdown stops them. See [the tested protocol and acceptance limits](docs/Provider_Protocol.md). Automated host tests use local fixtures without model requests; a separate real, tools-disabled CLI test confirmed streamed text, session-ID follow-up, and usage in a scratch directory.
