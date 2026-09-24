# Hydra Settings, connectors and MCP servers

Status: **plan** (2026-09-24).

## Goal

One **Hydra Settings** tab laid out like Cursor Settings: a left nav with search, and pages of cards with rows. It replaces today's single long Settings page, and is where you connect Claude Code and Codex, manage MCP servers, and choose how chats are shown.

Already done (PR #193): VS Code's own Settings and Keyboard Shortcuts open as tabs, not a floating overlay (`workbench.editor.useModal: off`).

## Pages

### General

Taken from Cursor's General page, minus the account rows (Hydra has no account):

| Row | Action |
| --- | --- |
| Editor settings: font, formatting, minimap and more | Open → VS Code Settings tab |
| Keyboard shortcuts | Open → Keyboard Shortcuts tab |
| Import from VS Code or Cursor: settings, keybindings, snippets | Import → the existing importer (preview, choose categories, one-click undo) |
| Reset "Don't ask again" dialogs | Show → clears Hydra's dismissed prompts |
| **Chat location** | **Docked** (default) / **Tabs**, see below |
| Window layout | Editor / Agents picker, like Cursor's Agent/Editor tiles; sets the startup mode |

### Connectors

One card per agent: Claude Code and Codex. Each shows:

- State: Installed / Connected / Signed in, with the extension version.
- One **Connect to Hydra** button: installs, connects, and for Claude also sets up claude-mem. Plus Disconnect and Sign in.
- For Claude: the claude-mem memory status, with a Repair button.
- A "What Hydra wrote" disclosure: the exact user-level entries (`claude mcp` server and allow rule, the Codex `config.toml` block and `AGENTS.md` block), so it's transparent.

This moves the existing `helperConnectionsView` into the card style. The behaviour is unchanged.

### MCP servers

Manage your other MCP servers for both agents from one place.

- **List:** servers already configured at user level:
  - Claude: `claude mcp list -s user`, or reading `~/.claude.json` `mcpServers`.
  - Codex: `[mcp_servers.*]` in `~/.codex/config.toml`.
  - A server that exists for both shows once, with two chips. Hydra's own `hydra` server is shown locked, managed on Connectors.
- **Add:** a form with name, type (stdio command + args + env, or HTTP URL + headers), and **Use with:** Claude Code, Codex, or both.
  - Claude: `claude mcp add-json -s user <name> <json>`.
  - Codex: a marked block per server (`# >>> Hydra MCP: <name>`), the same pattern as Hydra's own block, removed byte-exactly.
- **Remove / enable per agent:** a toggle per chip. Removing touches only what it added, or runs `claude mcp remove` for Claude entries.
- **Test:** starts the server briefly and runs MCP `initialize` + `tools/list`, then shows the tool count or the error.
- **Secrets:** env values that look like tokens are masked in the UI. They're stored where each agent already stores them; Hydra keeps no copy.
- **Never** edits servers it didn't add in Codex's file, and never reformats either file (Official_Extensions_Plan rules).

### Heads

- Heads at a time (`hydra.maxConcurrentHelpers`, 1–8).
- Default caps: minutes, turns, budget.
- **Stop all heads** button, and a link to the Heads guide.

### Appearance

- Dark / Light (the existing control).
- Icon theme (vscode-icons default, or others installed).

### Docs

- Links to the Heads guide, the Build guide and the README.

## Chat location: Docked (default) or Tabs

- **Docked** (default, today's behaviour): the Claude Code and Codex chats live in the right side bar, locked in place.
- **Tabs:** chats open as editor tabs, like Cursor: one tab per conversation, renameable, several at once.

How to implement:

- **Claude Code:** its own setting `claudeCode.preferredLocation` (`sidebar` | `panel`). Tabs means `panel`, and the ✳ button and "Open in New Tab" create tabs. Hydra writes the user setting when you switch.
- **Codex:** no location setting. Tabs means Hydra's "open chat" actions call `chatgpt.newCodexPanel` (opens Codex in an editor tab) instead of revealing the side bar view. Verify in the probe what the Codex side bar icon does in each mode.
- The side bar icons stay in both modes. In Tabs mode, clicking one opens a new tab.
- Stored as `hydra.chatLocation`: `docked` | `tabs`, applied at startup and whenever it changes.

## Build approach

- **Webview:** the same stack as the existing settings page (`src/extensionSettings.ts`), restructured with a left nav plus pages, and search across row titles. The styles follow the Cursor reference: card groups, row title + description, and right-aligned actions.
- **Entry points:** the title bar gear → **Hydra Settings** at the top of its menu; the command **Hydra: Open Settings**; and `Ctrl+Shift+,`.
- **Core modules:**
  - `src/core/mcpServers.ts`: read, add and remove for both agents, with byte-exact marked blocks for Codex and fixtures in tests.
  - `src/core/chatLocation.ts`: apply the mode.

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | Settings shell: left nav, search, page routing, card styles. Move today's rows into General / Heads / Appearance. | **Sonnet** |
| 2 | Connectors page: move the connection cards in, add the "What Hydra wrote" disclosure and the claude-mem Repair button. | **Sonnet** |
| 3 | Chat location toggle: `hydra.chatLocation`, Claude via `claudeCode.preferredLocation`, Codex via `chatgpt.newCodexPanel`. Probe-verify both modes. | **Sonnet** |
| 4 | MCP servers: `mcpServers.ts` (list/add/remove/test), with byte-exact round-trip tests for `config.toml`; then the page UI. | **Opus** for the config-safety design, **Sonnet** for the UI |
| 5 | Gear menu, keybinding, docs (README, Heads guide), and the full gate. | **Sonnet** |

Phases 1–3 can run in parallel (separate files); phase 4 after 1. Each goes through the local gate, a PR, and Nico's OK before merge.

## Later: "Switch to Hydra Agent" when a provider hits its limit (Freebuff)

**Idea (Nico):** when Claude or Codex hits its usage limit, offer **Switch to Hydra Agent**. Hydra's own agent, running on Freebuff, continues the work with an automatic handoff.

Not in the phases above. It needs its own research first:

1. **Freebuff:** check its terms, pricing and API or CLI, and whether it may be embedded and driven by another app.
2. **Detecting the limit:**
   - Heads: Hydra runs the CLIs, so it sees the rate-limit error directly.
   - The official extensions' own chats: Hydra can't read their UI. Options: a manual "Continue in Hydra Agent" button, or a hook if the extensions expose one.
3. **Handoff contents:**
   - Neither extension exports its chat history, so the handoff is a generated summary: the task, what's done, what's left, the current diff, and open questions.
   - For a head, it's everything Hydra already has: the brief, scope, progress notes and the branch.
4. **Where the Hydra Agent runs:** as another provider for heads (the simplest path: a head whose provider is `hydra`), then later as a chat of its own.

A separate plan doc once Freebuff's terms are checked.
