# Native task review

Stop the task's managed process or terminal before reviewing. If the task is externally owned, stop its official-extension session and acknowledge handback in the original Hydra window. Hydra cannot stop a manually launched external writer.

Refresh **Changes**, then select a layer under a file. Native diffs open in the second editor group with the manager retained in the first. **Open file** still opens an existing worktree file for normal editing; deleted files are available through their diff layers.

| Layer | Before | After |
| --- | --- | --- |
| Base → saved files | Recorded task base commit | Current saved file or deletion |
| Committed | Recorded task base commit | Captured task HEAD |
| Staged | Captured task HEAD | Stage-zero index blob or deletion |
| Unstaged | Stage-zero index blob | Current saved file or deletion |
| Untracked | Empty | Current untracked saved file |

Git's NUL-delimited name-status records retain original and destination paths for each rename. The inventory unions every layer; staged changes remain visible even when a later working edit cancels the net base-to-saved difference. Missing sides are empty documents, not attempted reads of deleted files. Git paths are passed as literal argv data. Text conversion and external diff drivers are disabled; diff opening does not submit model requests.

Both sides are owned, read-only, immutable virtual documents using VS Code's public content-provider and `vscode.diff` APIs. Unsaved editor buffers are preserved and excluded from the saved-file snapshot. Disk edits do not silently update an open comparison: refresh and reopen to capture new state. No review approval is saved, and opening a diff does not authorize integration.

Binary/NUL content, explicit `-diff` attributes, non-UTF-8 text, files over 2 MiB, and submodules open a native metadata notice with side kind, byte size, mode, and available Git object ID. These contents are not truncated into pretend text comparisons. Symlinks are reviewed as link-target text without following targets. Existing parents must remain inside the canonical task worktree; traversal and escaping junctions are rejected. Unmerged index layers direct users to native Source Control conflict resolution; committed snapshots remain inspectable.

Open snapshot content is bounded to 32 MiB and released when the corresponding native documents close. Current snapshots are per-file evidence, not an atomic capture of the whole worktree or a persisted reviewed-state token. Writers launched outside Hydra remain outside its ownership checks. Clean merge/fast-forward integration, reviewed-state invalidation, conflict recovery, and confirmed discard are separate M4 features.

Validation uses real Git repositories with dirty main checkouts, Unicode paths, each Git layer, canceled staged changes, renames/deletions, binary/attribute/encoding/size limits, gitlinks, symlinks/junctions, and conflicts. Actual Windows VS Code host tests assert native diff documents and their contents, fixed snapshots after disk edits, binary notice behavior, preservation of unsaved buffers, and unchanged provider request logs. Manual accessibility/layout review remains pending.

Public sources: [Git diff](https://git-scm.com/docs/git-diff), [VS Code virtual documents](https://code.visualstudio.com/api/extension-guides/virtual-documents), and [VS Code built-in commands](https://code.visualstudio.com/api/references/commands).
