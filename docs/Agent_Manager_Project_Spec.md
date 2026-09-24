# Hydra IDE

*Product specification and implementation brief*

Owner Nico Dunlap   |   17 September 2026   |   Proposed v1

### Product intent

Build a Windows-first Hydra desktop IDE with two working modes: Editor and Agents. Prove the agent workflow as a VS Code extension first, then bundle a maintained desktop editor distribution with a Windows installer. Editor mode keeps the familiar file explorer, tabs, code editor, source control, debugger, and terminal. Agents mode rearranges the workspace into a Zed-inspired agent manager with a task list, active conversation, code or diff view, and terminal. A persistent toggle lets Nico move between the two without losing work or restarting agents.

Claude Code and Codex are the primary providers. Both their CLIs and their official VS Code extensions belong in the workflow. Each managed task gets its own Git branch and worktree so parallel agents can change separate checkouts and their results can be reviewed before integration.

Nico's agent-workflow direction is parallel isolated tasks with less duplicated work and retained quality checks. The [agent workflow roadmap](Agent_Workflow_Roadmap.md) makes the remaining scheduling, dependency, integration, context, model/effort, and usage gates explicit. These are planned capabilities until their acceptance checks pass; no token savings have been demonstrated.

### Core product promise

One development environment for writing code yourself, delegating tasks, watching progress, and reviewing the results. Switching modes changes the workspace view; it does not create a new task, send a model request, switch the repository branch, or erase conversation history.

### Recommended starting point

The product is its own Hydra IDE, built as a maintained desktop editor distribution and installed through a Windows setup executable. The existing extension implementation becomes a built-in Hydra module; `.vsix` files and VS Code hosts are development tools, not the final delivery or a runtime dependency. Prioritize the standalone build foundation before extending the remaining agent milestones. See [Standalone build](Standalone_Build.md) and [Desktop delivery and onboarding](Desktop_Delivery.md). Use native editing and terminal surfaces alongside a custom agent interface. A perfect workbench rearrangement remains an acceptance gate rather than an extension API guarantee. [1]

### Scope for the first release

- Editor and Agents modes; Claude Code and Codex; managed CLI sessions plus official-extension handoff; isolated worktrees; native diff review; persistence and recovery; local usage visibility where available.

- Personal use on Windows 11 first. Cursor, macOS, Linux, remote execution, cloud agents, team accounts, and marketplace distribution are later work, not release blockers.

- No custom model gateway, credential harvesting, promised token discount, or automatic multi-agent swarm. The product coordinates existing tools and keeps their supported authentication flows.

## The two mode experience

### Agent orchestration visual

Nico's visual reference is an n8n-style workflow canvas above the Agents workspace: a dotted background, recognizable provider logos, visible node ports, curved directional connections, and multiple accent colors. Keep the IDE's black/white primary and dark-green actions; use coral, teal, and blue to distinguish providers and checkout relationships inside the canvas. Keep task text and status labels readable without relying on color alone.

The first map shows recorded repository → worktree → assigned-agent relationships and locally observed managed activity. Selecting an agent opens its task. Motion pauses for approval, inactive or unobserved sessions, the pause control, and reduced-motion preference. Collapse and zoom controls keep the view useful in small windows. Rendering and interaction use local code with zero model calls.

When scheduling and task dependencies are implemented, add actual dependency and handoff edges with event provenance. Do not infer communication between agents from shared repository membership or animate estimated token traffic. Unobserved official-extension sessions remain explicitly labeled.

### Editor mode

Use the familiar Cursor composition: normal Explorer and native navigation on the left, native editor tabs and splits in the center, agent conversation in the right secondary sidebar, and integrated terminal, output, problems, and debug console below. Hydra's right conversation selects the same isolated-worktree tasks, transcripts, approvals, and provider sessions as Agents mode; it does not create a separate agent loop. The orchestration graph appears only in Agents mode. Official Claude Code and Codex extension panels remain available. A compact status item shows active tasks and approvals that need attention.

Switching modes preserves native tabs (including diffs), split groups, terminal processes, and sidebar choices. Saved moved, hidden, and resized views remain under native workbench control. Unsent follow-up drafts survive mode switches within the current window; application-restart draft persistence is a later increment. Focus, visibility, and mode changes never launch provider requests.

### Agents mode

| Area | Content and behavior |
| --- | --- |
| Left task rail | Tasks grouped by repository. Show title, provider, status, branch, age, and change counts. Include New task, search, and filters for running, attention, and completed tasks. |
| Center conversation | Selected task transcript, collapsible tool activity, actionable approval requests, provider and model controls where supported, and a composer. |
| Right code area | Native VS Code editor or diff for the selected task worktree. Show repository, branch, and worktree identity clearly. |
| Bottom terminal | Terminal bound to the selected worktree. Keep existing terminals alive and label each one with its task. |
| Mode control | Editor / Agents switch inside the manager, plus a persistent status-bar command and configurable keyboard shortcut. |

Use the supplied Zed screenshot as the reference for density and hierarchy: narrow task rail, readable conversation, substantial code area, and terminal beneath. Use the Hydra palette below alongside native VS Code typography, keyboard behavior, and accessibility conventions. Keep the native workbench theme under the user's control. Avoid dashboard cards and decorative chrome.

### UI colors

Nico's selected direction is Cursor-style near-black with white text, with a dark green secondary. These are Hydra's initial implementation values, not a claim to reproduce Cursor's exact theme tokens.

| Token | Color | Use |
| --- | --- | --- |
| Primary | `#141414` | Main manager and editor background |
| Primary text | `#F5F5F5` | Text on the primary background |
| Secondary | `#173C2C` | Primary action buttons and active mode |
| Secondary hover | `#24553F` | Hovered green actions |
| Rail | `#111111` | Task rail and supporting chrome |
| Surface | `#1B1B1B` | Inputs and inset surfaces |
| Border | `#2B2B2B` | Quiet separators |
| Muted text | `#999E9A` | Supporting labels |
| Green text | `#A4C7B1` | Readable green accents on near-black |

The manager uses this dark palette by default and follows a native light theme when selected. Provide **Hydra Dark** and **Hydra Light** themes, with a Hydra Settings page that switches the native editor, terminals, and manager together. Apply changes only after an explicit appearance choice; importing settings preserves the imported theme until changed. Continue using native font, focus, and accessibility conventions, and defer to native colors in high-contrast mode.

### Toggle contract

- Preserve open files, unsaved buffers, editor selection, task selection, transcript position, terminal processes, and running agent sessions.

- Remember each mode’s supported layout state. Restore focus predictably. Never close an unsaved editor just to arrange the manager.

- Selecting a task opens its worktree files; it must not silently retarget an existing terminal or change the main checkout branch.

- Hiding or closing the manager view does not stop work. Stop is an explicit task action. Attention badges remain visible in Editor mode.

### Feasibility gate

Prototype the layout using supported VS Code commands and APIs. Exact restoration of arbitrary user layouts and terminal placement must be tested. If exact workbench control is essential and cannot be achieved, decide explicitly whether to relax the layout or build a maintained editor distribution. Do not depend on private DOM manipulation. [1]

## Claude Code and Codex integration

Treat provider and interface as separate choices. A task records who runs it, where it runs, and which interface currently owns the session. Managed CLI sessions and official-extension sessions have different levels of observability.

| Path | v1 behavior |
| --- | --- |
| Managed CLI | Manager creates the worktree, launches the provider, displays supported structured events, and owns stop, resume, and approval handling when exposed. |
| Interactive CLI | Open the provider in a native terminal at the task worktree. Keep this available when structured integration is unavailable. Do not infer “done” from a quiet terminal. |
| Official extension | Open the task worktree as a VS Code workspace, in a separate window when necessary, and let the user operate the official extension there. Show this as an external session unless a documented bridge provides reliable state. |

### Codex adapter

Use Codex App Server as the preferred structured integration. Its documented protocol supports clients over stdio and provides version-specific generated schemas. Test initialization, thread creation, turn events, approvals, interruption, and resume against a pinned CLI version. Keep protocol differences inside the adapter. Use an exec-style fallback only for capabilities verified in that version; otherwise use the interactive CLI. [2]

### Claude Code adapter

Begin with the official CLI and verify its supported structured input, output, permissions, and resume behavior on Windows. Consider the Claude Agent SDK only after validating its authentication and account requirements for this application; do not assume it inherits a subscription login. Preserve the official terminal path if structured integration cannot meet these requirements. [3, 6]

### Extension handoff

Provide Open in Claude Code and Open in Codex actions through documented commands when available. The dependable fallback is opening the exact worktree folder and giving a short instruction to open the installed provider extension. The provider retains its own login and permissions. [3, 4]

Claude documents shared history between its official extension and CLI, including CLI resume. Validate that flow for the chosen launch mode and working directory. Do not generalize it into guaranteed history sharing between custom manager sessions, both providers, or every extension surface. [3]

### Honest capability reporting

Probe availability and record support for streaming, follow-up messages, approvals, stop, resume, usage, and extension handoff. Unsupported controls stay disabled with an explanation. Never scrape another extension’s private storage, tokens, or UI. Allow only one active writer per task; handing off pauses or stops the previous writer first.

## Task isolation and the Git lifecycle

### Create and run

Select a repository, provider, task prompt, and committed starting point. Store the exact base commit and intended integration branch. Create a unique `agent/<slug>-<id>` branch and sibling worktree outside the repository, such as `<repo-parent>/<repo-name>.worktrees/<id>`. Start the terminal or managed agent with that directory as its working directory.

A dirty main checkout is not implicitly copied into a new worktree. Explain that the task starts from the selected commit; if the task needs uncommitted edits, require an explicit snapshot or commit workflow. Reject repositories without an initial commit. Keep Windows paths short and correctly handle spaces, Unicode, and Git path output.

### What isolation means

Worktrees isolate checkout files and indexes. They share repository metadata and are not a security sandbox. Agents can still access resources allowed by their process permissions. Provider sandbox and approval settings remain necessary. Terminals, ports, databases, dependency stores, and external services also require deliberate coordination.

Do not automatically copy secrets or ignored files. Offer an explicit per-project setup step for dependencies and approved configuration. Treat repository setup commands as executable code that requires workspace trust. Make setup failures visible before launching the agent.

### Review and integrate

- Review committed changes relative to the stored base commit, plus staged, unstaged, and untracked work. Include deleted and renamed files. Show binary changes without pretending they are text diffs.

- Pause the task writer before final review. Capture the reviewed commit and working-tree state so new changes invalidate the approval to integrate.

- Require task changes to be committed or explicitly committed through the finish flow. Git merge alone does not carry uncommitted edits.

- Check that the intended target branch is checked out in the target checkout and that it is clean. Serialize integration operations per repository. Offer merge or fast-forward only; stop on conflicts and open the native conflict workflow.

- Keep task branches and worktrees until integration succeeds. Discard requires confirmation that identifies unmerged commits and uncommitted changes. Never force-remove an active worktree silently.

### Recovery and ownership

Use distinct states for queued, starting, running, waiting for approval, idle, completed, interrupted, external, and error. After restart, reconcile saved metadata, processes, and Git worktrees; do not mark a vanished process as completed. Detect and prevent duplicate session ownership across windows. Only terminate processes owned by this manager.

## Token efficiency without sacrificing quality

The interface does not make model tokens cheaper. It can reduce avoidable requests, redundant context, and duplicated work. Actual savings depend on provider behavior, model choice, task difficulty, and account billing. Treat efficiency as a measured outcome, not a marketing promise.

| Control | Default and quality safeguard |
| --- | --- |
| No model work for UI actions | Switching modes, selecting tasks, refreshing Git status, and opening diffs use local code. Never ask a model to poll progress or generate a title automatically. |
| Focused task context | Send the user’s goal, constraints, relevant paths, and acceptance criteria. Do not automatically inject the entire repository or every open file. |
| Continuity when useful | Resume related work through supported provider mechanisms. Start a new task for unrelated work. Never silently replay the full transcript into a fresh session. |
| Bounded concurrency | Proposed default: at most two managed tasks running at once; queue the rest. Parallelism improves throughput but can increase total token use. |
| Explicit model choice | Use the provider default initially. Expose model and effort settings only when supported. Never silently downgrade a difficult task to reduce consumption. |
| Small handoffs | Use a user-reviewed summary of intent, decisions, changed files, and unresolved issues. Include pointers to the worktree and full local transcript for recovery. |

### Adaptive delegation on prompt submission

Planned feature: in **Auto**, the main agent assesses whether a prompt warrants independent subagents or should stay solo. Provide a persistent **Solo** override. Auto becomes the default only after provider, recovery, and efficiency acceptance; development starts opt-in. Give children only focused goals, necessary user/repository constraints, relevant source references, agreed interfaces, and completion checks. Start fresh child sessions without automatically copying the parent conversation; allow authorized retrieval of missing context.

Use isolated worktrees for writing children, one delegation level, a default two-child total per parent run, and the existing shared capacity including the active parent. Children return compact evidence-linked results. The parent reviews actual changes and validates the integrated result. Persist real assignments and handoffs for the agent map, and account for planning, retries, children, and integration without double-counting provider usage. Parallel speed is not proof of token savings. Full behavior, provider limits, budgets, phases, and release gates are specified in [Hydra helpers](Heads.md) (which replaced adaptive delegation).

### Keep optimization outside the hidden agent loop

Store full local output when available and collapse verbose output visually. Collapsing the UI does not reduce model context. A supported provider hook may filter repetitive logs before they reach the model, but it must preserve failures and access to complete evidence. Do not strip agent tool results or force frequent compaction behind the user’s back. Provider-native context management is the baseline. [5]

### Usage and budget visibility

Display input, output, cached usage, and cost only when the provider reports them with known semantics. Distinguish token counts, monetary estimates, and subscription limits. Use “Unavailable” when measurements are missing. A soft warning may stop new turns or queued launches; a strict in-flight spending cap is not guaranteed without provider enforcement.

### Measure before claiming savings

Compare ordinary CLI or extension use against the manager on the same representative tasks, commits, models, and acceptance tests. Record completion quality, regressions, manual rework, elapsed time, and reported usage across repeated runs. Ship an optimization only when it reduces waste without a material quality drop. Correctness checks remain part of the task budget.

## Implementation architecture

Use strict TypeScript for the extension and provider adapters, with a React webview for the task list and conversation. Reuse native editors, diff views, terminals, and theme variables. Keep task and worktree logic separate from VS Code UI code.

| Component | Responsibility |
| --- | --- |
| ModeController | Toggle modes, preserve supported layout and focus, maintain persistent activity indicators. |
| TaskManager | Task lifecycle, queue, concurrency, session ownership, event routing, and recovery. |
| WorktreeService | Create and reconcile worktrees, record base commits, calculate complete changes, and serialize integration. |
| Provider adapters | Availability, supported capabilities, launch, stream events, send, approvals, interrupt, resume, and usage. |
| ExtensionBridge | Documented provider commands and correct-workspace handoff; explicit limits on external-session visibility. |
| LocalStore | Versioned metadata, append-only event logs, atomic updates, migrations, and retention controls. |

### Task record and event model

Persist task ID, title, repository identity, canonical worktree path, branch, base commit, integration target, provider, interface, provider version, session ID, state, timestamps, ownership information, and available usage data. Store transcripts separately. Add an event sequence number so reconnects do not duplicate output.

Normalize message, tool call, tool result, approval request, state, usage, and raw diagnostic events. Preserve provider-specific fields when necessary. Approval requests need stable IDs and supported choices; a single allow/deny boolean is insufficient for every permission scope.

### Runtime and security boundaries

- Validate every webview message and file path. Restrict resource access to the intended worktree, use a content security policy, and render provider text as untrusted content.

- Launch executables with argument arrays and safe Windows shim handling. Never concatenate task prompts into shell commands. Keep credentials in official provider authentication flows.

- Keep metadata and transcripts local by default; provide deletion and retention controls. Agent requests still go to the selected provider under its own settings.

- Closing the UI preserves running tasks. Extension shutdown must stop owned processes or reconnect through a deliberately designed supervisor; do not promise background survival without one.

### Settings

Expose default provider, CLI paths, worktree root, maximum concurrent tasks, merge mode, optional trusted setup, default launch interface, and usage warnings. Make provider-specific arguments an advanced, validated setting. Probe supported features rather than hard-coding model catalogs or assuming authentication from binary presence.

## Build milestones and acceptance

### Desktop delivery requirements

The bundled release uses Hydra branding and the README logo for the application and shortcut. Its Windows installer includes an optional **Create a desktop shortcut** checkbox. First launch opens skippable onboarding with **Import from VS Code**, **Import from Cursor**, appearance, and provider-owned subscription sign-in actions. Import previews settings/keybindings/snippets and preserves source applications and existing Hydra preferences; it never copies credentials or private application databases. Anthropic subscription setup launches the unmodified official Claude Code authentication flow; OpenAI setup uses supported Codex ChatGPT sign-in. The in-IDE Settings page provides dark/light appearance and access to onboarding. Detailed gates and implementation order are in [Desktop delivery and onboarding](Desktop_Delivery.md).

Deliver a usable terminal workflow early, then add structured integrations. Each milestone has a concrete release gate; unverified provider or layout assumptions should not become invisible dependencies.

| Milestone | Acceptance gate |
| --- | --- |
| M0  Toggle prototype | On Windows, switch between Editor and Agents with unsaved files and an active terminal. Preserve work and focus; prove the supported layout and record limitations. |
| M1  Worktrees and terminals | Create three tasks with different branches and paths; respect the configured concurrency limit. Launch both CLIs in the correct worktrees. Restart and recover task records without inventing completion. |
| M2  Official extensions | Open each task worktree with both official extensions. Verify the actual workspace used by the provider. Demonstrate a documented history handoff where supported and an explicit fallback otherwise. |
| M3  Structured sessions | For Claude Code and Codex, verify streaming, follow-up, permissions, stop, and resume for every advertised capability. Show actionable errors and preserve raw diagnostics on protocol failure. |
| M4  Review and integration | Review committed, staged, unstaged, untracked, renamed, and deleted changes. Demonstrate clean integration, conflict recovery, dirty-target refusal, and safe discard. |
| M5  Reliability and efficiency | Install the .vsix on Windows. Test multiple windows, paths with spaces, interrupted setup, stale sessions, and unsupported versions. Verify that UI operations make zero model requests. |
| M6  Desktop delivery | Install/uninstall the standalone Windows IDE; test the desktop-shortcut checkbox both ways, branding, first-run and replayed onboarding, VS Code/Cursor import and rollback, dark/light settings, supported provider sign-in and cancellation, upgrades, and local-data preservation. A .vsix alone does not pass this gate. |

### Definition of done

Nico can install and launch the standalone Hydra IDE without installing VS Code, choose whether the installer creates a desktop shortcut, import VS Code/Cursor preferences during skippable onboarding, select dark/light appearance, and complete supported provider-owned account setup. In Hydra he can open a Git project, flip into the agent manager, start Claude Code and Codex tasks in isolated worktrees, use either the managed CLI experience or a supported official extension, return to ordinary editing, review all changes, and integrate or discard each result without losing work or confusing which checkout an agent is using. Standalone build, onboarding, provider acceptance, and safe integration/discard must all pass; the core `.vsix` alone is not done.

### Decisions to validate during implementation

- Can supported editor APIs achieve an acceptable one-toggle layout and restore it reliably? Nico has selected a maintained desktop editor distribution for final bundling; validate its build, updates, and extension compatibility separately from the prototype.

- Which installed provider versions expose the required protocol, approval, resume, and usage features? Record tested versions and schemas.

- Which Claude launch path supports Nico’s intended account authentication? Does each provider offer a documented extension handoff for that path?

- Can reported usage support a useful comparison? If not, ship transparent controls without a savings percentage or fabricated cost meter.

## Reference notes

Official documentation checked on 17 September 2026. Product requirements in this brief are proposed behavior; provider capabilities must also be verified against the versions used during implementation.

### 1  VS Code workbench extension capabilities

Supported extension surfaces and the foundation for the layout feasibility gate.

https://code.visualstudio.com/api/extension-capabilities/extending-workbench

### 2  Codex App Server

Structured client integration, stdio transport, lifecycle, and version-specific protocol schemas.

https://learn.chatgpt.com/docs/app-server

### 3  Claude Code in VS Code

Official extension workflow and documented CLI conversation resume.

https://code.claude.com/docs/en/vs-code

### 4  Codex IDE extension

Official Codex extension entry point and installation guidance.

https://learn.chatgpt.com/docs/codex/ide

### 5  Claude Code cost management

Provider-native context management and why redundant context and parallel sessions can increase usage.

https://code.claude.com/docs/en/costs

### 6  Claude Code programmatic use

Entry point for verifying supported programmatic operation and account requirements.

https://code.claude.com/docs/en/headless

### Project inputs

Agent Manager for VS Code handoff supplied by Nico, plus the supplied Zed interface screenshot. The screenshot establishes the desired task-list, conversation, editor, and terminal arrangement.
