# Implementation status

Features ship in separate branches and PRs. Type checking, builds, appropriate tests, and packaging must pass before a feature is merged.

| Feature | State | Evidence / limits |
| --- | --- | --- |
| UI palette and appearance | Implemented; automated Windows native checks passed | Black and white dark primary, dark green secondary; Hydra Dark and Hydra Light themes; in-IDE Settings changes appearance only on explicit choice; manager follows native light/high-contrast modes. Host tests verify native theme switching, settings-tab reuse, workspace-override refusal, and preserved unsaved text, terminal process, and task records; manual visual/accessibility acceptance remains pending |
| M0 mode prototype | Implemented; automated Windows checks passed | Status bar, shortcut, React manager, safe native text-tab behavior. Three mode cycles preserve unsaved text, selection, focus, and the existing terminal process |
| M1 worktrees and terminals | Foundation implemented; Windows automated checks passed | Three isolated tasks, both terminal launch routes, concurrency limit, recovery, and ownership tested. Real-provider sessions still require acceptance validation; interactive terminal workflow refuses extra launches rather than queuing them |
| M2 official extensions | Handoff foundation implemented; authenticated acceptance pending | Generated single-worktree workspaces for both providers; public-command availability checks; explicit prompt copy; persistent external ownership and safe failure handling. Automated native workspace loading tested. No automatic transcript transfer or observed external completion; real-provider/history validation pending |
| M3 structured sessions | Claude and pinned Codex structured foundations implemented; milestone incomplete | CLI 2.1.270 streamed text, explicit session-ID follow-up, and usage confirmed with a real tools-disabled scratch test. Windows fixture/host tests cover persistence, recovery, malformed output, writer exclusion, and process-tree stop. Codex 0.154.0 adapter adds stable initialization, streaming, explicit thread resume, scoped command/file/network approvals, readiness checks, and protocol interrupt with owned-tree fallback. Real Codex schema/initialization checked; authenticated model/tool acceptance, broader approval prompts, Claude interactive approvals/graceful interruption, and full interrupted-session acceptance remain pending |
| M4 review and integration | Native diff foundation implemented; integration/discard pending | Stopped tasks open immutable native diff snapshots for base-to-saved, committed, staged, unstaged, and untracked layers. Renames/deletions, binaries, encoding/size limits, gitlinks, conflict refusal, path boundaries, unsaved-buffer preservation, and zero provider requests tested. Review is not approval to integrate; reviewed-state validation, clean integration, conflict recovery, and confirmed discard remain pending |
| M5 reliability and efficiency | Planned | Cross-window recovery and ownership, packaging, failure paths, measured efficiency |
| M6 desktop delivery and onboarding | Required; planned | Standalone Windows installer with optional desktop shortcut, isolated profile, VS Code/Cursor import, provider-owned subscription setup, replayable onboarding. See Desktop_Delivery.md; current artifact remains a .vsix prototype |

## Layout decision

Use supported editor webviews alongside native editor groups and terminals. M0 does not rearrange the editor grid, close text tabs, or manipulate private DOM. Returning to Editor restores the previously active text editor and its selection and visible range. Native terminals are not recreated by the toggle.

Exact restoration of every arbitrary editor/sidebar/panel layout is not claimed. Full multi-pane layout and manual accessibility checks remain part of the feasibility gate.
