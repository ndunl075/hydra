# Implementation status

Features ship in separate branches and PRs. Type checking, builds, appropriate tests, and packaging must pass before a feature is merged.

| Feature | State | Evidence / limits |
| --- | --- | --- |
| UI palette | Implemented | Black and white primary, dark green secondary; optional Hydra Dark theme; no automatic theme changes |
| M0 mode prototype | Implemented; automated Windows checks passed | Status bar, shortcut, React manager, safe native text-tab behavior. Three mode cycles preserve unsaved text, selection, focus, and the existing terminal process |
| M1 worktrees and terminals | Next | Task records, isolated Git worktrees, provider terminal launch, recovery, concurrency |
| M2 official extensions | Planned | Exact-worktree handoff, validated provider history behavior |
| M3 structured sessions | Planned | Protocol/version validation, streaming, approvals, resume, interruption, reported usage |
| M4 review and integration | Planned | Complete native diffs, clean integration, conflicts, confirmed discard |
| M5 reliability and efficiency | Planned | Cross-window recovery and ownership, packaging, failure paths, measured efficiency |

## Layout decision

Use supported editor webviews alongside native editor groups and terminals. M0 does not rearrange the editor grid, close text tabs, or manipulate private DOM. Returning to Editor restores the previously active text editor and its selection and visible range. Native terminals are not recreated by the toggle.

Exact restoration of every arbitrary editor/sidebar/panel layout is not claimed. Full multi-pane layout and manual accessibility checks remain part of the feasibility gate.
