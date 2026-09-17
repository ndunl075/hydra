# Implementation status

Features ship in separate branches and PRs. Type checking, builds, appropriate tests, and packaging must pass before a feature is merged.

| Feature | State | Evidence / limits |
| --- | --- | --- |
| UI palette | Implemented | Black and white primary, dark green secondary; optional Hydra Dark theme; no automatic theme changes |
| M0 mode prototype | Implemented; automated Windows checks passed | Status bar, shortcut, React manager, safe native text-tab behavior. Three mode cycles preserve unsaved text, selection, focus, and the existing terminal process |
| M1 worktrees and terminals | Foundation implemented; Windows automated checks passed | Three isolated tasks, both terminal launch routes, concurrency limit, recovery, and ownership tested. Real-provider sessions still require acceptance validation; interactive terminal workflow refuses extra launches rather than queuing them |
| M2 official extensions | Handoff foundation implemented; authenticated acceptance pending | Generated single-worktree workspaces for both providers; public-command availability checks; explicit prompt copy; persistent external ownership and safe failure handling. Automated native workspace loading tested. No automatic transcript transfer or observed external completion; real-provider/history validation pending |
| M3 structured sessions | Planned | Protocol/version validation, streaming, approvals, resume, interruption, reported usage |
| M4 review and integration | Planned | Complete native diffs, clean integration, conflicts, confirmed discard |
| M5 reliability and efficiency | Planned | Cross-window recovery and ownership, packaging, failure paths, measured efficiency |

## Layout decision

Use supported editor webviews alongside native editor groups and terminals. M0 does not rearrange the editor grid, close text tabs, or manipulate private DOM. Returning to Editor restores the previously active text editor and its selection and visible range. Native terminals are not recreated by the toggle.

Exact restoration of every arbitrary editor/sidebar/panel layout is not claimed. Full multi-pane layout and manual accessibility checks remain part of the feasibility gate.
