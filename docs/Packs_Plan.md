# Packs

Status: **plan** (2026-09-25).

## Goal

A **pack** bundles what one kind of work needs: **roles** for lanes and plan jobs, **gates**, **MCP servers** and **skills**. A project turns packs on; a project that hasn't turned a pack on gets nothing from it.

- Hydra ships two packs, **Coding** and **Research**. You can add your own as folders.
- Turning a pack on shows exactly what it will run. Nothing runs before that.
- Hydra never writes a pack into your Claude Code or Codex settings. Everything reaches the CLIs through per-process flags, the way Hydra's own server already does.
- The only file in the repository is `.hydra/packs.json`, which you can commit.

**Out of scope:**
- a gallery or marketplace;
- installing packs from a URL;
- editing packs inside Hydra;
- packs for the official extensions' chats: Hydra doesn't start those processes, so it can't pass them flags.

## What exists today

- **Heads** (`src/core/helperRunner.ts`):
  - **Claude:** `claudeHelperArguments` passes Hydra's server inline (`--mcp-config=<json>`) with `--strict-mcp-config`, so a head sees only Hydra's server. `--allowedTools` is `claudeHelperTools`: no web tools, no skill tool.
  - **Codex:** `codexHelperArguments` adds Hydra's server with `-c mcp_servers.hydra.*`, plus `approval_policy='never'` and `-s workspace-write`.
  - **First message:** `helperPrompt` (`helperService.ts`).
- **Lanes** (`laneLaunch` in `laneService.ts`):
  - Hydra's server is passed only when the provider isn't connected: Claude gets `--mcp-config <file>` (mode 0600), Codex gets `-c mcp_servers.hydra.*`.
  - A connected Codex lane still gets `-c mcp_servers.hydra.env.*` for its lane identity.
  - The first prompt is `lanePreamble` (`lanes.ts`): one line, at most 4000 characters, passed as an argument. Through a Windows `.cmd` shim it is filtered by `shimSafe`.
- **Gates:** `loadGates(folder)` (`src/core/gates/config.ts`) reads `.hydra/gates.json`, or else `checks.json`, from the lead folder only. It has four callers:
  - `HelperService.done`;
  - `runGates` (a lane's Run gates and Merge);
  - the Merge case in `LanesController.run`;
  - Settings → Gates.
- **MCP servers page:** user-level servers only. `validateServerSpec`, `maskSpec`, `looksLikeSecret` and `testMcpServer` (`src/core/mcpServers.ts`) can be reused as they are.
- **No roles:** a lane has a name, provider and goal; a plan job has a title, brief and provider.

## What the CLIs support

Checked against the installed Claude Code 2.1.282 and Codex 0.154.0 on 2026-09-25. Items marked R1–R9 are settled live in phase 1 (see "Research to settle in phase 1"). The design keeps a fallback for each.

| Need | Claude Code | Codex |
| --- | --- | --- |
| Extra instructions for one session | `--append-system-prompt <text>` is listed. `--append-system-prompt-file` is named in the help text but not listed as an option: **R1**. | No flag. `-c key=value` overrides any config key; a developer-instructions key: **R2**. Multi-line text can't pass through the npm `codex.cmd` shim (cmd.exe), so only a file-based key helps. Codex also reads `AGENTS.md` from the repository and `~/.codex`; Hydra writes neither for packs. |
| Extra MCP servers for one session | `--mcp-config <configs...>` takes several files or strings, and `--strict-mcp-config` limits the session to them. Both are used today. `${VAR}` in these files, and passing an inline config plus a file: **R3**. | `-c mcp_servers.<name>.*`, used today. `env_vars` (pass variables through by name) and tool approval for these servers under `codex exec`: **R4**. |
| Extra skills for one session | `--plugin-dir <path>`: "Load a plugin from a directory or .zip for this session only", repeatable. A plugin can hold `skills/`. Details: **R5**. | `codex features list` shows plugin and skill features as stable. But `codex plugin add` installs at user level, and there is no per-session flag. A `-c` key for an extra skills folder: **R6**. |
| Web tools for a head | Add `WebSearch` and `WebFetch` to `--allowedTools`. | `--search` is a top-level flag; its `exec` equivalent: **R7**. |
| Reading pack files from a head | Files outside the worktree may need `--add-dir`: **R8**. | Read access outside the worktree under `workspace-write` on Windows: **R8**. |

## 1. What a pack contains

### Roles

A role is a preset for a lane or a plan job, for example **Builder**, **UI builder**, **Reviewer**, **Researcher** or **Fact-checker**.

| Field | Meaning |
| --- | --- |
| `id`, `title`, `description` | `id` is `[a-z0-9-]{1,24}` and unique in the pack. Shown as "Reviewer (Coding)". |
| `provider` | The default agent, `claude` or `codex`. You can still pick the other one. |
| `instructions` | A Markdown file in the pack, at most 8000 characters: how to work in this role. |
| `skills` | Skill ids from this pack that the role gets. |
| `mcpServers` | Server ids from this pack that the role gets. |
| `tools` | Extra rights for heads. Only `"web"` for now. |
| `changes` | `"required"` (the default) or `"optional"`. A head in an optional-changes role may finish without changing anything; its summary is then the result. For reviewers and fact-checkers. |

How a role reaches each CLI is in section 5.

### Gates

A pack's gates join the project's gates while the pack is on.

- **Schema:** the same as a gate in `gates.json`, parsed by the same `parseGate`. Two additions are allowed only in a pack:
  - **`{pack}`** in a `command` or `start` argument becomes the pack's folder, so a pack can ship a check script, for example `["node", "{pack}/scripts/check-links.mjs"]`.
  - **`"role"` on a review gate** names one of the pack's roles, for example `"role": "fact-checker"`. The reviewer's prompt then includes that role's instructions.
- **Precedence** (`effectiveGates`):
  1. `.hydra/gates.json` (or `checks.json`) comes first.
  2. Then each active pack's gates, in the order `.hydra/packs.json` lists the packs.
  3. **The first gate with an id wins.** A project replaces a pack's gate by defining the same id in `gates.json`, for example its own `tests` command. A later pack's gate with a taken id is dropped.
  4. **Dropped gates are always shown**, as "Replaced by gates.json" or "Replaced by the Coding pack".
  5. **`skipGates`** in `packs.json` turns a pack gate off for the project.
- **What only `gates.json` controls:** `maxAttempts` and the `lanes` policy. A pack can't change either. With no `gates.json`, the defaults apply: 3 attempts, `onMerge`.
- **Order and caps:**
  - The effective list still runs command, then screenshots, then review (`gateOrder`).
  - A pack has at most 6 gates, and the effective list at most 24. Turning on a pack that would pass 24 is refused with the reason.
- **Results** carry `pack` (the pack's id), so chips and View evidence say "From the Coding pack".

### MCP servers

- **Schema:** a map of `id → McpServerSpec`: a stdio command with args and env, or an HTTP URL with headers. Checked by `validateServerSpec`.
- **Per session only.** A role's servers are passed to its lane's or head's own process, next to Hydra's server (section 5). `~/.claude.json` and `~/.codex/config.toml` are never touched.
- **Names:** a server runs as `<pack>-<id>`, for example `research-fetch`, so it doesn't clash with your own servers. If you already have a server with that exact name, the pack's server is skipped, with a note on the Packs page.
- **Secrets:** a pack never holds one. Env and header values are plain values or `${NAME}` references to your environment. A literal that `looksLikeSecret` is refused: "Put the secret in your environment and use ${NAME}."
- **Codex and the `.cmd` shim:** Codex servers are passed as `-c` arguments. A server whose command or arguments contain `'`, a line break, or characters cmd.exe expands (`% ^ & | < > ! "`) is marked **Claude only**. Codex sessions skip it and say so.
- **Test** on the Packs page runs `testMcpServer`, as the MCP servers page does.

### Skills

- **Format:** a skill is a folder `skills/<id>/` with a `SKILL.md`. Its front matter has `name` (the folder name) and `description`. Claude Code and Codex both use this format.
- **Who gets them:** a role lists the skills it gets.
- **Claude:** Hydra builds a small plugin per role from that role's skill folders only, and passes it with `--plugin-dir` (section 5). Nothing else from the pack goes into the plugin, so a pack can't add hooks, commands or servers this way. The skills show as `hydra-<pack>:<skill>`.
- **Codex:** per R6. The fallback works for any agent: the role's instructions end with a skill index, one line per skill with its description and the absolute path of its `SKILL.md`, and the line "Read the file before you use the skill."

## 2. Pack format and sources

### The folder

```
research/
  pack.json
  roles/researcher.md
  roles/fact-checker.md
  skills/cite-sources/SKILL.md
  scripts/check-links.mjs        (optional: used by a gate through {pack})
```

### `pack.json`

```json
{
  "version": 1,
  "id": "seo",
  "title": "SEO",
  "description": "Pages that rank: titles, structure and links.",
  "publisher": "Acme web team",
  "roles": [
    { "id": "seo-writer", "title": "SEO writer", "description": "Writes and fixes page metadata.", "provider": "claude",
      "instructions": "roles/seo-writer.md", "skills": ["meta-tags"], "mcpServers": ["lighthouse"] }
  ],
  "gates": [
    { "id": "meta", "type": "command", "command": ["node", "{pack}/scripts/check-meta.mjs"], "timeoutSeconds": 120 },
    { "id": "seo-review", "type": "review", "reviewer": "other", "focus": "Titles, descriptions, headings and internal links." }
  ],
  "mcpServers": {
    "lighthouse": { "type": "stdio", "command": "npx", "args": ["-y", "lighthouse-mcp@1.2.3"], "env": { "CHROME_PATH": "${CHROME_PATH}" } }
  }
}
```

### Validation (`src/core/packs/format.ts`, pure)

- **Unknown keys are refused** with the reason, as in `gates.json`, so a typo never silently turns something off.
- **Ids and text:** ids are `[a-z0-9-]{1,24}` and unique in their list. `publisher` is free text up to 80 characters, `description` up to 300.
- **Paths:** every file a pack names is inside its folder: no absolute paths, no `..`.
- **No links.** A folder with a junction or symbolic link anywhere in it is refused. This is the 2026-09-24 lesson.
- **Caps:**
  - 8 roles, 6 gates, 6 servers and 16 skills;
  - 200 files and 4 MB in all;
  - `SKILL.md` up to 64 KB;
  - role instructions up to 8000 characters.
- **References:** roles name only skills and servers the pack has. Every skill folder has a valid `SKILL.md`.
- **A broken pack** is listed with its problem and can't be turned on. It never breaks the others.

### Content hash

A pack's hash is SHA-256 over its files: the sorted relative paths, then each file's bytes. Any change to any file changes it. Section 4 uses it.

### Built-in packs

- **Where:** in `packs/` at the repository root. They ship in the `.vsix` and the desktop build, and are read from `<extensionPath>/packs`.
- **Gates:** review gates only. A built-in pack can't know a project's test command.
- **Downloads:** none.

**Coding** (`coding`)

| Kind | What | Notes |
| --- | --- | --- |
| Role | **Builder** (`builder`), Claude | Reads the code first, builds the feature with tests, keeps to the brief, runs the project's tests before finishing, and says what it didn't do. Skill: `test-first`. |
| Role | **UI builder** (`ui-builder`), Claude | Frontend work. Checks each change at 390, 768 and 1280 px, keyboard use, labels and contrast, and that the console is clean. Skill: `ui-check`. |
| Role | **Reviewer** (`reviewer`), Codex, `changes: "optional"` | Reads the diff against the target and lists findings with file:line and severity. Fixes blockers and majors only when asked. |
| Gate | `code-review`: review, reviewer `other`, required | Focus: correctness, missing tests for new behaviour, security (injection, secrets, unsafe paths), and whether the change does what the brief asks. Ignores style. |
| Skill | `test-first` | Write a failing test, make it pass, then tidy. |
| Skill | `ui-check` | How to run the project's dev server, check a page at three widths, and read the screenshots gate's report. |
| MCP servers | None | See open question 3. |

**Research** (`research`)

| Kind | What | Notes |
| --- | --- | --- |
| Role | **Researcher** (`researcher`), Claude, `tools: ["web"]` | Writes findings as Markdown in its write scope. Every claim has a source link and the source's date. Keeps facts apart from opinion, and lists open questions. Skill: `cite-sources`. |
| Role | **Fact-checker** (`fact-checker`), Codex, `tools: ["web"]`, `changes: "optional"` | Checks each claim in the changed Markdown against its source. Fixes it, or marks it "[unverified]" with the reason. Skill: `cite-sources`. |
| Gate | `fact-check`: review, reviewer `other`, `role: "fact-checker"`, required | Every factual claim in the changed Markdown has a link that supports it. Unsupported or misattributed claims are major. Whether a read-only reviewer can open links: **R9**. |
| Skill | `cite-sources` | How to cite: the link, title, date, and the quote the claim rests on. |

### User packs

- **Where:** one folder per pack in `~/.hydra/packs/`. The setting `hydra.packs.folder` (an absolute path) changes it. Hydra creates the folder the first time you open it.
- **Adding one:** **Add pack from folder…** on the Packs page validates a folder and copies it in. You can also copy folders in yourself; **Reload** or the file watcher picks them up.
- **Ids:** a user pack can't reuse a built-in pack's id ("coding is a built-in pack; choose another id").

## 3. Turning packs on for a project

### `.hydra/packs.json`

```json
{
  "version": 1,
  "packs": [
    { "id": "coding" },
    { "id": "research", "skipGates": ["fact-check"] }
  ]
}
```

- **Where it's read from:** the lead folder only, like `gates.json`, never from a worktree. So a head can't turn a pack on or off.
- **Order:** it sets gate precedence between packs, and the order roles are listed in.
- **Limits:** unknown keys are refused; at most 8 packs.
- **Who writes it:** Settings → Packs, with an atomic write, 2-space JSON and a trailing newline. You can commit it.

### Why a file, and not workspace state

| | `.hydra/packs.json` (recommended) | Workspace state |
| --- | --- | --- |
| The team gets the same packs | Yes, once committed | No |
| Survives a fresh clone or a new machine | Yes | No |
| Sits next to `gates.json` | Yes | No |
| A repository can turn a pack on by itself | It can ask; the pack still needs your OK on this machine (section 4) | No |

**Recommendation:** `.hydra/packs.json` for the project's choice, plus a small local record of what you allowed on this machine. The file says what the project wants; the local record says what you agreed to run.

### When a pack is active

A pack is **active** in a project when:

1. `packs.json` lists it;
2. it is installed, either built into Hydra or in your packs folder;
3. it is valid;
4. you allowed it on this machine for this project, and, for a user pack, its content hash still matches what you allowed.

| State on the Packs page | Why | What runs |
| --- | --- | --- |
| **Off** | Not in `packs.json` | Nothing |
| **On** | Active | Everything in it |
| **Needs your OK** | Listed, but not allowed here yet (for example, a teammate committed `packs.json`) | Nothing. Its gates show as **not run**: "The Coding pack isn't allowed on this machine yet." |
| **Changed** | A user pack's files changed since you allowed it | Nothing, until you review it again |
| **Not installed** | Listed, but neither built in nor in your folder | Nothing. One **not run** result names it. |
| **Invalid** | Its `pack.json` has a problem | Nothing |

The gates of a listed but inactive pack are reported as **not run**. A missing pack is then visible on every head and every lane merge; checks don't silently stop.

## 4. Trust and security

A pack can run commands (gates) and start processes (stdio MCP servers). It gives agents text they act on (instructions, skills, and scripts inside skills), and it can widen what heads may do (web tools, MCP tools). So:

- **Nothing runs until the pack is active** (section 3), and turning it on shows everything first.
- **The local record** is `globalStorage/packs/allowed.json`. It has one entry per project (canonical repository path) and pack, with the pack's source and, for a user pack, its content hash. It's written only when you press the button at the end of the review panel. A repository can't write it.
- **Built-in and user packs are trusted differently:**

| | Built-in pack | User pack (third-party) |
| --- | --- | --- |
| Who wrote it | Hydra, shipped with this version | Whoever wrote the folder |
| Turning it on | The review panel, then **Turn on** | The review panel with a warning ("Not from Hydra. Its author, not Hydra, decides what these commands and servers do."), then **Trust and turn on** |
| Pinned to | The Hydra version. An update doesn't ask again; the page says "Updated in Hydra x.y". | Its content hash. Any change to a file makes it **Changed** until you review it again. |
| When a teammate's `packs.json` lists it | Allowed once per project, from a notification ("This project uses the Coding pack. Review") | Only if you have the same pack installed; then once per project and hash |

- **The review panel lists, exactly:**
  - every gate command and start command as its argument list, with `{pack}` resolved, and when it runs: before a head's work is accepted, and when you merge a lane;
  - every MCP server: its command and arguments or URL, its env names (values masked with `maskSpec`), the roles that use it, and "Heads call its tools without asking";
  - every role: its provider, the tools it adds ("Heads with this role can browse the web"), and its instructions, which you can expand;
  - every skill with its files. Scripts are flagged: "Agents may run these."
- **Runs from a copy.**
  - When a pack is allowed, Hydra copies it to `globalStorage/packs/cache/<id>-<hash12>/`. Everything runs from that copy: `{pack}`, skill paths, role files and the Claude plugin folders.
  - Editing the source folder can't change what a running session uses. The next launch sees the new hash and stops using the pack.
  - Copying refuses links, and Hydra only ever deletes inside the cache folder.
- **The same rights as the session that runs it:**
  - **Gate commands** are tracked like other gate processes (`spawned`), so none of them can act as a lead.
  - **MCP servers** run as a child of the lane or head that starts them. In a head, a server is refused as a lead, as the head is. In a lane, it can do whatever the lane's agent can. The review panel says so.
- **Secrets** never live in a pack (section 1).
  - Claude's server config for a lane is a 0600 file in the lane's config folder, as `laneLaunch` does today, removed when the lane closes. For a head it's `<logDirectory>/<jobId>.mcp.json`, removed when the head ends.
  - For Codex, variables pass by name (R4), not on the command line.

## 5. Effects

### How a role reaches each CLI

Hydra resolves the role at every launch, from the active pack's cache copy, with `roleLaunch` (`src/core/packs/launch.ts`, pure). A lane's Resume, Start fresh and Switch to <Other> resolve it again, so the flags are passed every time.

| | Claude lane | Codex lane | Claude head | Codex head |
| --- | --- | --- | --- | --- |
| Instructions | `--append-system-prompt-file <cache>/roles/<id>.md` (R1). Fallback: `--append-system-prompt` with the text, when the executable isn't a `.cmd` shim. | A file-based `-c` key if R2 finds one. Fallback: the instructions in the first prompt, flattened and capped at 1500 characters. | A "Your role" section in the first message (`helperPrompt`) | Same |
| Skills | `--plugin-dir <cache>/claude/<role>` (R5) | R6, else the skill index | `--plugin-dir`, the skill tool in `--allowedTools` (R5), and `--add-dir <cache>` (R8) | R6, else the skill index in the first message (R8) |
| MCP servers | `--mcp-config <file>` with the role's servers, even when Claude is connected; plus `hydra` when it isn't | `-c mcp_servers.<pack>-<id>.*` for each server | A second `--mcp-config` file next to the inline Hydra config (R3), still `--strict-mcp-config`, with `mcp__<pack>-<id>` added to `--allowedTools` | `-c mcp_servers.<pack>-<id>.*`, with tool approval per R4 |
| `tools: ["web"]` | No flag; you approve as usual | No flag | `WebSearch` and `WebFetch` in `--allowedTools` | R7 |

When the Codex fallback is used, a Codex lane with a role but no goal still gets a first prompt: the role, then "Wait for the user's first request."

### Lanes

- **Record:** `Lane.role?: { pack: string; role: string }`. `LaneInput`, the `laneNew` message and `hydra.lanes.start` take `role` as `"pack/role"`.
- **Provider:** the form's choice. The role only sets the default.
- **Preamble:** `lanePreamble` adds one short sentence after its first: `Your role: Reviewer (Coding pack).` It stays one line under 4000 characters.
- **When the role goes away** (its pack is turned off, changed or uninstalled), the lane starts without it. Its tile says "Role Reviewer isn't available: the Coding pack is off."
- **`hydra_lanes`** lists each lane's role.

### Heads

- **Record:** `Job.role?` and `JobInput.role`.
- **Choosing a role:**
  - `hydra_start_head` gains an optional `role`: `"builder"` when only one active pack has it, else `"coding/builder"`. An unknown role is refused, and the error lists the available ones.
  - A plan job's role passes through to its head.
  - Without `provider`, a head takes its role's provider. `parseJobInput` defaults `provider` to Claude today, so it must first tell "not given" apart.
- **Launch:** `HelperService.launch` resolves the role. A head whose role isn't available fails before it starts: "Could not start: the role coding/builder isn't available (the Coding pack is off)."
- **`HelperRunSpec`** gains `role?: RoleLaunch`: the extra `--mcp-config` file, allowed tools, plugin and add dirs, and Codex `-c` pairs. `claudeHelperArguments` and `codexHelperArguments` add them.
- **Brief** (`helperPrompt`):

  ```
  You are a Hydra head (job 3f9c…): Build the cart API

  Your role: Builder (Coding pack)
  <the role's instructions>
  Skills you can use: test-first: Write a failing test first… (C:\…\SKILL.md)

  <the brief>
  ```

- **`changes: "optional"`:** `HelperService.done` accepts a head with no commits beyond its base when its role allows it. The summary is the result, `changedFiles` is empty, and no gates run, since there is nothing to check. Without the option, it still answers "You have not changed anything yet."
- **`HelperJobView.role`** and `hydra_get_head` show the role.

### Gates

- **`effectiveGates(folder, active)`** (`src/core/packs/gates.ts`) replaces `loadGates` for heads and lanes:
  - `HelperServiceOptions` and `LaneServiceOptions` gain a `gates(folder)` loader;
  - `runGates` takes the loader as a parameter;
  - the Merge case in `LanesController.run` uses it too.
- **Settings → Gates** still edits `gates.json` only, and shows the rest read-only (section 6).
- **`Gate` gains `pack?: string`**, set only by the loader; `parseGate` still refuses it in `gates.json`. `JobCheckResult` gains `pack?: string` too.

### Plans and the planner

- **`PlanJob.role?: string`** (`"pack/role"`). A head job passes it to its head, and a lane job to its lane ([Plan_Lanes_Plan.md](Plan_Lanes_Plan.md)).
- **Provider:** `runPlanById` takes the job's own provider, then the role's, then `hydra.defaultProvider`.
- **The planner:** when roles are active, `plannerPrompt` lists them (id, title and a one-line description) and allows an optional `"role"` per job. `parsePlanJobDraft` keeps a role that exists and drops any other.

## 6. UI

### Settings → Packs (a new page, after Gates)

- **Intro:** "Packs add roles, gates, MCP servers and skills to this project. Nothing from a pack runs until you turn it on here."
- **One card per pack**, built-in first. Each card shows:
  - the title, a source chip (**Built into Hydra** or **Your packs folder**) and the description;
  - the counts, for example "3 roles · 1 gate · 2 skills · 0 servers";
  - its state (section 3), with one button: **Turn on**, **Turn off**, **Review and allow** or **Review changes**.
- **What it contains:** a disclosure on each card listing roles, gates, servers and skills, laid out as the review panel lists them. Each server has **Test**. Each pack gate has **Skip in this project**, which writes `skipGates`.
- **Turn on** opens the review panel inside the card (section 4). The button at its end writes `packs.json` and the local record. The page then confirms: "Saved in .hydra/packs.json. Commit it to share these packs with your team."
- **Page actions:** **Add pack from folder…**, **Open packs folder** and **Reload**.
- **Wiring:** the page talks to the extension through commands, which smoke tests can also call: `hydra.packs.state`, `hydra.packs.setEnabled`, `hydra.packs.allow`, `hydra.packs.skipGate`, `hydra.packs.addFolder` and `hydra.packs.reload`. `pageOrder` gains `packs`.
- **Notification:** when a window opens a project whose `packs.json` lists a pack that needs your OK: "This project uses the Coding pack. Nothing from it runs until you review it." with **Review** and **Not now**.

### Settings → Gates

- **From packs:** a read-only group under the project's gates. Each pack gate shows its pack, and "Replaced by your gate" or "Skipped" where that applies. The group links to Packs.
- **Which folder:** the page reads and writes the lead folder (the first Git folder, as heads use), instead of the first workspace folder as it does today.

### Picking a role

- **New lane card** (`NewLaneCard`): a **Role** select under Agent, offering "No role" and then each active pack's roles in a group. Picking a role selects its provider, which you can still change. With no active pack, the select is disabled with the hint "Turn on a pack in Settings → Packs".
- **`hydra.newLane`:** a Role step comes first when roles exist, so the command has four steps.
- **Plan job popover** (`JobEditPopover`): a **Role** select. Provider **Auto** means the role's provider, then the default.
- **The webview's data:** `Snapshot.roles` (`{ ref, pack, packTitle, id, title, description, provider }`), refreshed whenever packs change.

### How roles show

| Where | How |
| --- | --- |
| Lane tile header | A role chip after the name, "Reviewer", with the tooltip "Coding pack · Codex by default" |
| Canvas, lane node | `Lane · Reviewer` above the name |
| Canvas, head card | The kind line reads "Claude head · Builder" |
| Canvas, draft job | The pill reads "Builder · Claude" |
| Hydra panel | A lane's description: "Codex · Reviewer · lane/x" |
| Gate chips | A pack gate's tooltip adds "From the Coding pack" |

## 7. Code layout

| File | What |
| --- | --- |
| `src/core/packs/format.ts` | Pure: `parsePackManifest`, `parsePacksFile`, the caps, `{pack}`, and the env and Codex-safety rules |
| `src/core/packs/registry.ts` | Finds built-in and user packs, validates and hashes them, and lists their problems |
| `src/core/packs/allowed.ts` | The local record (`globalStorage/packs/allowed.json`), with atomic writes |
| `src/core/packs/cache.ts` | The copy each pack runs from, the per-role Claude plugin folders, and the role files |
| `src/core/packs/project.ts` | Reading and writing `.hydra/packs.json`; `activePacks(folder)` |
| `src/core/packs/gates.ts` | `effectiveGates` |
| `src/core/packs/launch.ts` | Pure `roleLaunch(role, provider, paths)` for heads and lanes |
| `src/extensionPacks.ts` | The pack service in the window: commands, watchers on `packs.json` and the packs folder, the notification, and `Snapshot.roles` |
| `src/settings/pages/packs.ts`, `packsHelpers.ts` | The page, and its pure helpers |
| `packs/coding/`, `packs/research/` | The built-in packs |

**Changed:**
- `helperRunner.ts`, `helperService.ts`, `jobs.ts` and `helperTools.ts`: roles for heads, `changes`, and the gates loader.
- `lanes.ts`, `laneService.ts` and `extensionLanes.ts`: roles for lanes, and the gates loader.
- `gates/config.ts` and `gates/index.ts`: `Gate.pack` and the loader parameter.
- `plans.ts` and `planner.ts`: `PlanJob.role`, and the roles in the planner's prompt.
- `model.ts`: messages and views.
- `LanesView.tsx`, `AgentsCanvas.tsx`, `agentsCanvas.ts` and `hydraTree.ts`.
- `settings/pageOrder.ts`.
- `package.json`: the `hydra.packs.folder` setting.

[Plan_Lanes_Plan.md](Plan_Lanes_Plan.md) also changes `PlanJob` and the job popover. Build that plan first; phase 4 of this one then adds Role to the popover it leaves.

## Phases

| Phase | Work | Model |
| --- | --- | --- |
| 1 | **Research R1–R9** in an isolated probe window with the real CLIs, with the results written into this plan. Then the core: pack format, registry, hash, `packs.json`, the local record, the cache, `effectiveGates` wired into heads and lanes, and "not run" results for inactive packs. Unit tests with temp folders and real temp repos. | **Opus**: the trust model, and process and file safety |
| 2 | Launch effects, following the research: roles, skills, MCP servers and web tools for heads and lanes; `changes: "optional"`; `Job.role` and `Lane.role`. Argument-list tests for both CLIs, and shim safety. | **Opus**: CLI arguments and permissions |
| 3 | Content of the built-in packs: role instructions, skills and gate focus for Coding and Research. In parallel with 2. | **Sonnet**, reviewed by Opus |
| 4 | UI: Settings → Packs with the review panel; "From packs" on Gates; role pickers (New lane card, `hydra.newLane`, plan popover); role chips on tiles, the canvas and the panel; `role` in `hydra_start_head`; roles in the planner. After 1. | **Sonnet** |
| 5 | Integration, the live checks below, and docs (README, Heads.md, this plan's "As built"). | **Opus** |
| 6 | Local gate, PR, CI, merge, light refresh of the installed app, and ping Nico. | **Opus** |

### Research to settle in phase 1

Each item is tried live with Claude Code 2.1.282 and Codex 0.154.0. What was run and what was seen goes into this plan.

| # | Question | If the answer is no |
| --- | --- | --- |
| R1 | Does `--append-system-prompt-file` work in an interactive session, and with `--continue`? | `--append-system-prompt` with the text when the executable isn't a shim; else the first-prompt fallback. |
| R2 | Does Codex 0.154 have a config key that adds developer instructions from a file (adding to its base instructions, not replacing them), usable with `-c`? | The first-prompt fallback. |
| R3 | Does Claude expand `${VAR}` in `--mcp-config` files? Can a session take the inline Hydra config and a file together? | Hydra writes the resolved values into the 0600 file, and puts the head's servers in one file (with the token-free Hydra entry kept inline). |
| R4 | Does Codex pass `env_vars` through to a `-c` server? Are its tools callable under `codex exec` with approval `never`, and what does `default_tools_approval_mode` do for them? | Env values go in `-c`, where they're visible in the process list (the review panel says so), or the servers aren't offered to Codex heads. |
| R5 | Do skills from `--plugin-dir` load in interactive and `-p` stream-json sessions, and with `--continue`? What is the skill tool called in `--allowedTools`? What happens if an installed plugin has the same name? | Claude uses the skill index, like the Codex fallback. |
| R6 | Can Codex load an extra skills folder for one session, for example through a `-c` key? | The skill index. |
| R7 | How does `codex exec` turn on web search: a `-c` key or a flag? | `tools: ["web"]` works for Claude heads only, and the Packs page says so. |
| R8 | Can a Claude head (`dontAsk`, `--add-dir`) and a Codex head (`workspace-write`) read files in Hydra's global storage? | Copy the role's skill files into a folder in the worktree that Hydra excludes through `.git/info/exclude`, and read them there. |
| R9 | Can a read-only reviewer (`claude -p --permission-mode plan`, or `codex exec --sandbox read-only`) open a web page? | The `fact-check` focus only asks that every claim has a plausible source link; the Fact-checker role does the fetching. |

## Acceptance

**Unit tests:**
- **`pack.json`:**
  - ids and unknown keys;
  - references between roles, skills and servers;
  - files outside the folder, and links, are refused;
  - the caps;
  - secret literals are refused, and `${NAME}` is allowed;
  - Codex-unsafe arguments are marked Claude only.
- **`packs.json`:** round trip; unknown keys; duplicates; `skipGates` naming a gate the pack doesn't have.
- **Registry:** built-in and user packs are found; a broken pack is listed with its problem; a user pack can't reuse a built-in id.
- **Hash:** changing any file changes it; the order files are read in doesn't.
- **Active:** every state in section 3's table. A changed user pack goes inactive, and its gates come back as "not run" with the reason.
- **Effective gates:**
  - order: `gates.json` wins on an id, and an earlier pack wins over a later one;
  - `skipGates` and the 24 cap;
  - `{pack}` resolves to the cache copy;
  - `pack` is recorded on results;
  - `maxAttempts` and `lanes` come only from `gates.json`.
- **Head arguments:** for Claude, the extra `--mcp-config` file, the `--allowedTools` additions, `--plugin-dir` and `--add-dir`; for Codex, the `-c` servers. Nothing is added without a role.
- **`helperPrompt`:** the role section and the skill index. `changes: "optional"` accepts a `hydra_done` with no changes and runs no gates; `required` still refuses.
- **`laneLaunch`:**
  - Claude's role flags, also on resume;
  - a `--mcp-config` file even when Claude is connected;
  - Codex's `-c` servers and the first-prompt fallback;
  - everything is shim-safe.
- **`lanePreamble`:** the role sentence; still one line under the cap.
- **Cache:** a plugin folder holds only `skills/` and `plugin.json`; building it twice changes nothing; links are refused.
- **Parsing:** `parseJobInput` with `role`, and the provider coming from the role. The planner's prompt lists roles; its parser keeps known roles and drops others.
- **Packs page helpers:** commands are shown exactly, secrets masked, and each state has the right button.

**Smoke:**
- Settings → Packs is contributed, after Gates.
- `hydra.packs.state` lists Coding and Research.
- `hydra.packs.setEnabled` writes `.hydra/packs.json`, and the effective gates include `code-review`.
- With a test user pack whose command gate fails, a head is sent back with that gate's output.

**Live** (isolated probe window, real CLIs):
1. Turn on Coding. The review panel lists its roles, gate and skills, and `packs.json` is written.
2. A Claude lane as Builder follows its role (ask it "What is your role?"), and still does after Resume. A Codex lane as Reviewer does too.
3. A Claude lane as UI builder lists `hydra-coding:ui-check` among its skills. A Claude head as Builder uses `test-first`.
4. With a test user pack that has a tiny stdio MCP server, a connected Claude lane and a Codex lane both list its tools. `~/.claude.json` and `~/.codex/config.toml` are byte-identical before and after.
5. A head as Researcher fetches a web page; a head with no role can't.
6. `code-review` runs on a head and on a lane merge, and its chip says "From the Coding pack".
7. Edit the user pack's `pack.json`. The pack shows Changed and its gate isn't run, with the reason. Reviewing it again restores it.
8. In a fresh clone with a committed `packs.json`, the notification appears, and nothing from the pack runs until you allow it.

**Done** when the local gate passes (check, build, tests, smoke), the live checklist passes, the PR is merged with CI green, the installed app is refreshed, and Nico has the summary.

## Decisions (Nico, 2026-09-25)

1. **User packs live in `~/.hydra/packs`.** It's visible and easy to share. A project may also carry packs in `.hydra/packs/<id>/`: they're treated as third-party, pinned by content hash, and need your review before anything runs.
2. **A committed `packs.json` asks once per project**, built-in packs included, through the review panel, because packs can run commands.
3. **The Coding pack ships Playwright MCP** for the UI builder, pinned to one version. The review panel says it downloads from npm on first use.
4. **Roles may set an optional `model`.**
5. **A pack's MCP servers go only to the roles that list them.**
6. **Leads learn the active roles from their instructions,** plus the `role` enum on `hydra_start_head`.
7. **A `{node}` placeholder** runs Hydra's own executable as Node (`ELECTRON_RUN_AS_NODE`), so pack scripts don't need Node on PATH.

## As built

Not built yet. When it is, record where it lives, the changes from the plan, what was verified live, and what's not done.
