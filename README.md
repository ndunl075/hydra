<p align="center">
  <img src="./hydra-logo.png" alt="Hydra — three-headed hydra logo" width="220" />
</p>

# Hydra

A Windows-first standalone IDE for switching between ordinary editing and an agent manager. Hydra's own editor is built from pinned Code - OSS source with Hydra branding and separate user data; the agent workflow is a built-in module. The Windows installer and first-run onboarding are still in development. The product and acceptance gates are in [the project spec](docs/Agent_Manager_Project_Spec.md), [standalone build guide](docs/Standalone_Build.md), and [desktop delivery requirements](docs/Desktop_Delivery.md).

## Standalone editor build

The target application is **Hydra.exe**. VS Code is a development test host, not a runtime dependency of the bundled IDE. Native Windows x64 builds require the pinned Node/toolchain prerequisites described in the [build guide](docs/Standalone_Build.md).

The empty editor displays a subtle, one-color version of the README Hydra logo. It uses a transparent background and follows dark, light, and high-contrast themes.

```powershell
npm.cmd ci
npm.cmd run desktop:build
npm.cmd run desktop:verify
npm.cmd run desktop:smoke
```

The build lives in `.desktop/VSCode-win32-x64/`. The Windows CI job builds the same standalone app and runs the existing acceptance suite against its built-in Hydra module, using a separate empty test harness. A source `.vsix` does not satisfy the standalone release gate.

## Available features

- Open **Hydra: Toggle Editor / Agents** from the Command Palette or press **Ctrl+Alt+A**.
- A persistent status-bar control switches modes.
- The README's Hydra logo is used for the extension, sidebar, and agent-manager tab icons.
- The dark manager uses near-black (`#141414`), white text (`#F5F5F5`), and dark green (`#173C2C`). Open **Hydra: Open Settings**, or the manager's settings control, to select **Dark** or **Light** for the native editor, terminals, and manager. Both **Hydra Dark** and **Hydra Light** are available through the native theme picker too. Opening Hydra never changes your theme; an explicit appearance choice updates your user profile and disables automatic system dark/light switching. Workspace overrides are preserved with an explanation.
- In standalone Hydra, **Settings → Import preferences** previews settings, keybindings, and snippets from VS Code or Cursor, with a picker for custom User/profile folders. Select categories before importing into the active Hydra profile. Current preferences win on conflicts; unavailable settings/themes and credential preferences are skipped. **Undo last import** restores the saved backup unless newer edits would be overwritten. Source profiles, authentication stores, extension binaries, and conversations are left alone. See [import behavior](docs/Settings_Import.md).
- Returning to Editor restores the previously focused text document, selections, and visible range. The extension does not close text tabs or touch terminal processes.
- Create titled Claude Code or Codex tasks from the manager or **Hydra: New Task**. Each starts at committed HEAD in a unique `agent/…` branch and sibling worktree; dirty main-checkout edits stay in place.
- Open the provider in a native terminal at the exact worktree and use **Copy prompt** to paste the task when ready. Provider authentication, conversation, and permissions stay in the official CLI.
- Search and filter tasks, inspect worktree identity, refresh changed-file inventory, and open existing files in the native editor.
- Review stopped tasks in native read-only diff tabs: base-to-saved, committed, staged, unstaged, and untracked changes. Renames preserve both paths; deletions compare against an empty side. Binary, large, non-UTF-8, and submodule changes show metadata instead of a simulated text diff.
- Stage saved task changes, then **Prepare commit review** to inspect a fixed tree against the task base. **Commit reviewed tree** creates the exact reviewed commit, or records an already-committed tree. Stale changes, active writers, and unsaved task buffers refuse; native Git hooks still apply. The local receipt does not integrate the target branch. See [review behavior](docs/Native_Review.md#reviewed-task-commits).
- Stop a terminal explicitly. Task worktrees and branches remain available. Closing the manager or switching modes keeps the task terminals alive.
- Hand off an idle or stopped task with **Open in Claude Code** or **Open in Codex**. A generated `.code-workspace` opens in a separate window with only that exact checkout, the local task prompt, and the official extension recommendation.
- Run **Check Claude Code / Codex** in the manager to inspect the configured CLI version and public help, or use **Hydra: Check Default Provider Capabilities**. **View diagnostics** opens the captured arguments, stdout, stderr, and exit status locally.
- **Start managed Claude** streams a task through verified Claude CLI 2.1.270. Follow-ups resume its explicit session ID. Responses, raw events, and provider-reported usage are saved locally; **Stop process** terminates the owned process tree and leaves the turn interrupted.
- **Start managed Codex** uses pinned CLI 0.154.0 App Server: streamed text, recorded thread-ID follow-ups, provider token usage, scoped command/file/network approval cards, and explicit turn interruption. Windows sandbox readiness is checked before any model turn.
- Saved records recover after reload. Missing sessions become interrupted, never completed. Hydra stops its owned terminals on extension shutdown and does not promise background survival or automatic CLI resume.

The manager occupies a supported editor tab alongside native editors and terminals. Its compact **Agent map** connects each repository to its worktrees and assigned agents. Select an agent node to open the task; collapse the map or pause its motion at any time. Moving arrows indicate locally observed running managed sessions and stop for approvals. External sessions remain static because their progress is unavailable. Connections show checkout context; agent-to-agent dependencies and message flow are not implemented yet. The map follows the editor theme and reduced-motion preference, and makes no model requests.

The manager does not promise exact restoration of arbitrary grid layouts. Model controls, broader provider approval prompts, integration, and discard are subsequent features. Authenticated Codex acceptance remains pending.

## Provider and worktree settings

Install the official Claude Code and/or Codex CLI separately using its supported login flow. Hydra searches PATH; set **Hydra: Claude Path** or **Hydra: Codex Path** to an absolute executable path if needed. Executable presence does not prove authentication or protocol compatibility. Windows `.cmd` / `.bat` shims are launched through PowerShell with an encoded, quoted executable path; task prompts are never inserted into shell commands.

The default limit is two active managed processes or provider terminals. Extra launches are refused with an explanation; this terminal prototype does not implement the future managed-session queue. Tasks can still be created while that limit is reached. Configure **Hydra: Worktree Root** to choose an absolute directory outside the main repository. No secrets, ignored files, or dependencies are copied automatically.

One Hydra window owns each canonical repository at a time. A second owner displays an error and disables task operations. Records are local under VS Code's extension global-storage directory, with atomic, versioned metadata. Corrupt records are preserved for diagnosis. Worktrees isolate files and indexes; they are not a security sandbox.

## Core development and VS Code test host

Requires Node.js 22 and VS Code 1.95 or newer.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run test:smoke
npm.cmd run package
```

Press **F5** in this repository to launch a VS Code Extension Development Host for fast core tests. `hydra-core-0.14.0.vsix` is a development artifact for **Extensions: Install from VSIX**, not the final Hydra product. Settings import is unavailable in that development host. The standalone installer and subscription-account onboarding remain upcoming desktop features.

`npm.cmd test` runs real-Git safety, storage, and handoff ownership tests. The smoke test uses installed VS Code on Windows and downloads a host on other platforms. It checks three mode cycles, three isolated tasks in a dirty repository, both provider launch routes with local test executables, exact terminal working directories, duplicate prevention, concurrency, and recovery in a second fresh host. Two additional hosts load the actual generated Claude and Codex workspace files, validate checkout identity, and test the missing-extension fallback. These executables make no model requests and do not validate authenticated provider sessions. Linux CI runs the same host tests under Xvfb. Failed fixtures are retained under `.test-build` for diagnosis.

## Official extension handoff

The target window opens Hydra's handoff instructions without launching a provider or submitting a prompt. Select **Open Claude Code** or **Open Codex** there to invoke the provider's public UI command; select **Copy task prompt** and paste it yourself. The official extension owns login, conversation, permissions, and session history. CLI installation is not required for this route. Missing or disabled extensions show an installation search; an unsupported command shows the documented Command Palette fallback.

Hydra marks the task externally owned before opening the window. It blocks another handoff or CLI writer while ownership remains external, including after reload or an ambiguous window-opening failure. Hydra cannot observe or stop the external provider. Stop its session in the target window, then select **I stopped the external session** in the original Hydra window to return ownership. This is your acknowledgment, not an automated stop check. Close the old target window before starting another session; Hydra cannot prevent you from manually reopening a provider or running a CLI outside its controls.

No transcript or history is copied. Use history controls in the official provider; no automatic CLI-to-extension resume is claimed. Claude documents shared history and `claude --resume`, but authenticated worktree/session matching still requires acceptance testing. Codex history transfer is not asserted. No private extension data, credentials, or unsupported session APIs are accessed.

The bridge uses `claude-vscode.editor.open` from the public Claude Code extension manifest (checked against version 2.1.269) and the documented Codex `chatgpt.openSidebar` command. It checks the installed extension's public command contribution and registration before invoking it. See [Claude's VS Code guide](https://code.claude.com/docs/en/vs-code), [Codex's IDE guide](https://learn.chatgpt.com/docs/codex/ide), and [Codex command documentation](https://learn.chatgpt.com/docs/developer-commands?surface=ide). End-to-end authenticated provider/history and manual visual checks remain pending; the milestone is a handoff foundation.

## Provider diagnostics

Checks are explicit, never triggered by mode changes, task creation, startup, or refresh. They run only `--version`, `--help`, and (for Codex) `app-server --help`, with an eight-second limit per call and a combined 256 KiB stdout/stderr limit. Timeout, cancellation, and excess output terminate the owned probe process tree. No task prompt, authentication request, session, or model request is sent.

The manager distinguishes help-advertised options from verified adapter capabilities. Recognizing a version or option does not prove authentication, account billing, streaming compatibility, or resume support. Unknown output and failed probes remain actionable diagnostics; the interactive terminal stays available. Checks reset on Hydra configuration changes or reload. Managed sessions support only the pinned versions documented below. Public help is a metadata check, not an authenticated session test.

## Managed Claude sessions

Claude CLI 2.1.270 is the tested contract; other versions retain the terminal route. Hydra rechecks the configured binary before each turn. Select **Start managed Claude** to send the task prompt, then type and send follow-ups after the current process has ended. Each turn uses `claude -p` with streamed JSON and the exact worktree as its working directory. Follow-ups use only the recorded `--resume` session ID. No live steering or automatic resume is claimed.

The CLI retains its existing authentication and environment. Hydra does not collect credentials, set a model, or bypass permissions. It selects default/manual permissions and denies unresolved prompts with `--permission-prompts none`; provider permission rules and hooks still apply. Denials are shown, and the terminal remains available for work needing interactive approvals. Existing API-key environment variables can affect the CLI's billing route; subscription billing is not asserted.

A finished model turn leaves the task idle for follow-up, rather than claiming the code task is reviewed or integrated. A valid final result and successful exit are both required. Missing results, invalid JSON, worktree/session/version mismatches, and nonzero exits are failures with retained diagnostics. **Stop process** forcibly terminates the owned tree; it is not graceful protocol interruption. Check the checkout before resuming interrupted work, because provider history may omit unfinished output.

Owned session storage contains atomic conversation snapshots and sequenced append-only raw event logs. Reload recovers text and session IDs, marks unfinished turns interrupted, and never sends a model request automatically. The view shows ten recent turns and up to 50,000 response characters per turn, with visible truncation notices; full local output is retained. A 32 MiB per-turn output guard stops excessive output with an error. Token figures are provider-reported, and dollar figures are provider estimates, not an asserted bill or savings percentage.

Managed processes and terminal writers share the configured concurrency cap; extra starts are refused rather than queued. An active managed writer blocks terminal launch and extension handoff for that task. Mode changes preserve running processes; extension shutdown stops them. See [the tested protocol and acceptance limits](docs/Provider_Protocol.md). Automated host tests use local fixtures without model requests; a separate real, tools-disabled CLI test confirmed streamed text, session-ID follow-up, and usage in a scratch directory.

## Managed Codex sessions

The adapter supports official Codex CLI **0.154.0** only. Hydra rechecks its version/help before each turn, initializes the documented stable stdio App Server protocol, and starts or resumes only the recorded root thread ID. It validates the effective worktree, version, approval policy, and sandbox before sending the prompt. The provider retains login, configured model, and environment; Hydra does not read credentials or private history. Billing routes are not asserted.

Turns request a workspace-write sandbox confined to the task worktree, with restricted network and temporary-directory write exclusions. Command, file, and network requests appear as scoped approval cards. **Allow this request** or **Decline** answers that one live request; no persistent policy amendment or session-wide grant is offered. Full provider request details remain visible and in local raw diagnostics. Unsupported permission, elicitation, user-input, or credential-refresh prompts fail explicitly and stop the owned process; use the official client for those flows.

On Windows, Hydra checks public `windowsSandbox/readiness` without changing system settings. If setup is absent or needs updating, complete it in the official Codex client and retry. A returned read-only or incompatible policy also stops startup before a model turn; Hydra never treats a failed sandbox request as successful editing access.

**Stop process** sends `turn/interrupt` for the exact active thread/turn, waits for completion, and falls back to stopping its owned process tree if cancellation fails. A turn requires a matching final status and clean process exit to finish; a finished turn leaves the code task idle for review. Reload preserves responses and provider-owned IDs, clears pending approvals, marks unfinished turns interrupted, and never restarts a model automatically. A session cannot be resumed through a different provider after handoff.

Version-generated request types are checked into source with provenance. Local fixtures and real VS Code hosts validate streaming, resume, approvals, interruption, storage, errors, writer exclusion, and shared concurrency without model requests. The real Windows CLI passed schema generation and initialization; its isolated test home lacked a ready editing sandbox. **Authenticated Codex model/tool acceptance is still pending**, and that limitation is recorded in [protocol evidence](docs/Provider_Protocol.md). See the [official App Server guide](https://learn.chatgpt.com/docs/app-server).

## Native change review

Stop the task writer, refresh **Changes**, and choose a comparison under a file: **Base → saved files**, **Committed**, **Staged**, **Unstaged**, or **Untracked**. This shows all Git layers, including staged edits canceled by later working edits. Renames compare the original and destination paths; deleted files have an empty after side. Existing files retain **Open file** for normal native editing.

Text comparisons open native read-only snapshot tabs alongside the manager, labeled with task/branch and captured HEAD. Unsaved buffers are preserved and excluded from saved-file comparisons. Snapshots stay fixed after edits; refresh and reopen when needed. Binary, explicit `-diff`, non-UTF-8, submodule, and over-2-MiB content show metadata notices. Open snapshot content is bounded to 32 MiB. Unmerged index layers direct you to native Source Control conflicts.

Review makes no model requests and does not stage, commit, merge, or mark a task completed. Snapshots do not authorize integration. Guarded integration validates exact reviewed commits in retained candidates. Reversible confirmed discard reviews saved state, requires native confirmation and retains the checkout for explicit restore. See [task discard](docs/Task_Discard.md). See [native review behavior and acceptance evidence](docs/Native_Review.md). Real-Git tests and Windows native host tests cover each layer, rename/deletion, binary handling, path boundaries, dirty-buffer preservation, and unchanged provider request logs.
