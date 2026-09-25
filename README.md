<p align="center">
  <img src="./hydra-logo.png" alt="Hydra — three-headed hydra logo" width="220" />
</p>

# Hydra

Hydra is an IDE built to orchestrate multiple AI coding agents in parallel, giving each agent its own isolated worktree while you monitor, review, and control everything from one workspace.

**Hydra heads.** In the myth, the Hydra is one creature with many heads, each acting on its own. Hydra's subagents are named after them. You chat with one agent, Claude Code or Codex, which is the body and makes the decisions. When a task splits into independent pieces, it grows heads: separate agents, each working in its own git worktree and branch at the same time. When a head finishes, Hydra checks its work, and the lead reviews it and merges it back. You don't have to ask for heads; the lead decides when splitting a task is worth it. See [Hydra heads](docs/Heads.md).

## Standalone editor build

The target application is **Hydra.exe**. VS Code is a development test host, not a runtime dependency of the bundled IDE. Native Windows x64 builds require the pinned Node/toolchain prerequisites described in the [build guide](docs/Standalone_Build.md).

Fresh Hydra profiles default to Hydra Dark without following the system light theme; an explicit saved or imported appearance choice still wins. Light mode remains available in Settings. The empty editor displays a subtle, one-color version of the tightly cropped README Hydra logo, with the full mark intact and minimal outer padding. It uses a transparent background and follows dark, light, and high-contrast themes.

```powershell
npm.cmd ci
npm.cmd run desktop:build
npm.cmd run desktop:verify
npm.cmd run desktop:smoke
```

The build lives in `.desktop/VSCode-win32-x64/`. The Windows CI job builds the same standalone app and runs the existing acceptance suite against its built-in Hydra module, using a separate empty test harness. A source `.vsix` does not satisfy the standalone release gate.

## Available features

- Open **Hydra: Toggle Editor / Agents** from the Command Palette or press **Ctrl+Alt+A**. The Agents view is a live canvas of Hydra heads: blank until a Claude Code or Codex chat starts heads, which grow out of that chat, show what they're working on and how they depend on each other, and leave once merged. See [the Agents view](docs/Heads.md#the-agents-view).
- **Lanes** run agents you drive yourself. Each lane is a real Claude Code or Codex terminal in its own git worktree, shown in a grid under **Agents → Lanes**. Hydra warns when lanes would conflict with each other or with main, and lets you merge, update, open a PR or close each lane. **Plans** let you draft jobs on the canvas, by hand or from a brief, and run each one as a head or as a lane you drive; **Mark job done** hands a lane's work on to the jobs after it. The **Hydra** icon in the activity bar lists lanes, heads and plans. See [Lanes](docs/Heads.md#lanes) and [Plans](docs/Heads.md#plans).
- **Gates:** no agent grades its own work. A head's changes, and a lane's when you merge it, must pass this project's gates first: your commands (tests), screenshots of your app, and a read-only review by the other agent. Set them up in **Hydra Settings → Gates** (`.hydra/gates.json`). **View evidence** shows the output, findings and screenshots. When the agent in a lane hits its usage limit, the lane offers to **continue in the other agent** in the same worktree. See [Gates](docs/Heads.md#gates).
- A persistent status-bar control switches modes. Editor mode keeps native files and diffs in the center, Explorer on the left, terminals below, and the official Claude Code and Codex chats in the native secondary sidebar.
- Returning to Editor closes only the Agents tab and lets native tab history restore the preceding editor, including diffs and split groups. Mode switches preserve sidebar choices and terminal processes.
- In standalone Hydra, open **Hydra: Provider Usage Limits**. Opening is passive; explicitly refresh account windows through tested Codex 0.154.0 without submitting a model turn. Missing fields remain unavailable, observations are timestamped, and stale data is labelled. Claude limits remain unavailable with official `/usage` guidance. See [provider usage limits](docs/Provider_Quotas.md).
- The README's Hydra logo is used for the extension and Agents tab icons.
- Standalone Hydra looks and behaves like Cursor in the Explorer and around the agent chats:
  - [vscode-icons](https://github.com/vscode-icons/vscode-icons) (MIT) is bundled and set as the default file icon theme, pinned by version and SHA-256. Sidebar file icons are drawn at 14px instead of 16px.
  - The app icon at the top left of the title bar is the Hydra logo.
  - UI icons use the classic codicon designs, as Cursor does (for example the plain "+" New File and New Folder buttons). `desktop/codicon-classic.ttf` is the pinned codicon font with glyphs from [@vscode/codicons](https://github.com/microsoft/vscode-codicons) 0.0.41 by Microsoft, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and modified by merging them into the newer font. `scripts/desktop-classic-codicons.py` regenerates it.
  - The built-in GitHub Copilot chat and inline suggestions are off by default (`chat.disableAIFeatures`); Hydra's agents are Claude Code and Codex.
  - Hydra Dark and Hydra Light use Cursor's colours for the Explorer, lists and git decorations.
  - The Claude Code and Codex chat panels are locked in place, as Cursor's chat is. They can't be dragged into the editor, the Explorer or the panel, and other views can't be dropped into them. You can still reorder icons in a bar, or move a panel on purpose from its icon's right-click menu.
- **Hydra Settings** opens as a tab laid out like Cursor Settings: a left nav with search, and pages of cards. Open it from the top of the title bar gear menu, **Hydra: Open Settings**, or `Ctrl+Shift+,`. Its pages:
  - **General:** editor settings and keyboard shortcuts, import from VS Code or Cursor, reset dismissed prompts, **Chat location** (Docked in the side bar, or Tabs like Cursor), and the startup **Window layout** (Editor or Agents).
  - **Connectors:** connect Claude Code and Codex to Hydra, see exactly what Hydra wrote to their user settings, and repair claude-mem. When one hits its usage limit, Hydra offers to continue in the other, with a handoff (`hydra.limits.offerHandoff`); see [Heads.md](docs/Heads.md#when-a-provider-hits-its-limit).
  - **MCP servers:** list, add, test and remove your user-level MCP servers for Claude Code, Codex or both. Hydra keeps no copy of secrets and never edits Codex servers it didn't add.
  - **Heads:** heads at a time, default caps (minutes, turns, budget), and **Stop all heads**.
  - **Appearance** (Dark/Light, icon theme) and **Docs**.
- The dark Agents view uses near-black (`#141414`), white text (`#F5F5F5`), and dark green (`#173C2C`). Open **Hydra Settings → Appearance**, or the Agents view's settings control, to select **Dark** or **Light** for the native editor, terminals, and Hydra pages. Both **Hydra Dark** and **Hydra Light** are available through the native theme picker too. Opening Hydra never changes your theme; an explicit appearance choice updates your user profile and disables automatic system dark/light switching. Workspace overrides are preserved with an explanation.
- In standalone Hydra, **Hydra Settings → General → Import from VS Code or Cursor** previews settings, keybindings, and snippets from VS Code or Cursor, with a picker for custom User/profile folders. Select categories before importing into the active Hydra profile. Current preferences win on conflicts; unavailable settings/themes and credential preferences are skipped. **Undo last import** restores the saved backup unless newer edits would be overwritten. Source profiles, authentication stores, extension binaries, and conversations are left alone. See [import behavior](docs/Settings_Import.md).
- Returning to Editor closes only the Agents tab and lets native tab history restore the preceding editor, including diffs and split groups. Mode switches preserve sidebar choices and terminal processes. The canvas of heads stays in Agents.
- **Hydra: Check Default Provider Capabilities** inspects the configured CLI version and public help. See [provider diagnostics](#provider-diagnostics).

## Provider and worktree settings

Install the official Claude Code and/or Codex CLI separately using its supported login flow. Hydra searches PATH; set **Hydra: Claude Path** or **Hydra: Codex Path** to an absolute executable path if needed. Executable presence does not prove authentication or protocol compatibility.

Heads run in sibling worktrees. Configure **Hydra: Worktree Root** to choose an absolute directory outside the main repository, and **Hydra: Max Concurrent Helpers** to cap how many heads run at once in a window. No secrets, ignored files, or dependencies are copied automatically. Worktrees isolate files and indexes; they are not a security sandbox.

One Hydra window owns each canonical repository at a time. A second owner displays an error and does not start heads. Records are local under VS Code's extension global-storage directory.

## Core development and VS Code test host

Requires Node.js 22 and VS Code 1.95 or newer.

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build
npm.cmd run test:smoke
npm.cmd run package
```

Press **F5** in this repository to launch a VS Code Extension Development Host for fast core tests. The `.vsix` is a development artifact for **Extensions: Install from VSIX**, not the final Hydra product. Settings import and quota refresh are available in standalone Hydra. The installer, replayable onboarding and passive provider account setup have passed automated Windows acceptance; live sign-in, signing/distribution and the remaining delivery gates are tracked in [implementation status](docs/Implementation_Status.md).

`npm.cmd test` runs the heads, real-Git worktree, storage and handoff tests. The smoke test uses installed VS Code on Windows and downloads a host on other platforms. It checks three mode cycles, diff and split-group preservation, Settings, provider capability checks with local test executables, quota refusal outside standalone Hydra, and a restart in a second fresh host. Two additional hosts load generated Claude and Codex handoff workspaces, validate checkout identity, and test the missing-extension fallback. These executables make no model requests and do not validate authenticated provider sessions. Linux CI runs the same host tests under Xvfb. Failed fixtures are retained under `.test-build` for diagnosis.

## Official extension handoff

A Hydra handoff workspace is a generated `.code-workspace` that opens one exact worktree with a `hydra.handoff` descriptor. The window opens Hydra's handoff instructions without launching a provider or submitting a prompt. Select **Open Claude Code** or **Open Codex** there to invoke the provider's public UI command; select **Copy task prompt** and paste it yourself. The official extension owns login, conversation, permissions, and session history. Missing or disabled extensions show an installation search; an unsupported command shows the documented Command Palette fallback. Hydra cannot observe or stop the external provider, and no transcript or history is copied.

The bridge uses `claude-vscode.editor.open` from the public Claude Code extension manifest (checked against version 2.1.269) and the documented Codex `chatgpt.openSidebar` command. It checks the installed extension's public command contribution and registration before invoking it. See [Claude's VS Code guide](https://code.claude.com/docs/en/vs-code), [Codex's IDE guide](https://learn.chatgpt.com/docs/codex/ide), and [Codex command documentation](https://learn.chatgpt.com/docs/developer-commands?surface=ide).

## Provider diagnostics

Checks are explicit, never triggered by mode changes, startup, or refresh. They run only `--version`, `--help`, and (for Codex) `app-server --help`, with an eight-second limit per call and a combined 256 KiB stdout/stderr limit. Timeout, cancellation, and excess output terminate the owned probe process tree. No prompt, authentication request, session, or model request is sent.

Recognizing a version or option does not prove authentication, account billing, streaming compatibility, or resume support. Checks reset on Hydra configuration changes or reload. Public help is a metadata check, not an authenticated session test.

## License

Hydra is released under the [MIT License](LICENSE). It is built on Code - OSS by Microsoft (MIT) and bundles vscode-icons (MIT) and codicons (CC BY 4.0); their notices ship with the app.
