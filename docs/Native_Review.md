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

Both sides are owned, read-only, immutable virtual documents using VS Code's public content-provider and `vscode.diff` APIs. Unsaved editor buffers are preserved and excluded from the saved-file snapshot. Disk edits do not silently update an open comparison: refresh and reopen to capture new state. Opening an ordinary layer diff does not save review approval or authorize integration.

Binary/NUL content, explicit `-diff` attributes, non-UTF-8 text, files over 2 MiB, and submodules open a native metadata notice with side kind, byte size, mode, and available Git object ID. These contents are not truncated into pretend text comparisons. Symlinks are reviewed as link-target text without following targets. Existing parents must remain inside the canonical task worktree; traversal and escaping junctions are rejected. Unmerged index layers direct users to native Source Control conflict resolution; committed snapshots remain inspectable.

Open snapshot content is bounded to 32 MiB and released when the corresponding native documents close. Ordinary layer snapshots are per-file evidence. Writers launched outside Hydra remain outside its ownership checks. [Reviewed integration](Integration.md) now provides guarded candidate merges, conflict recovery and target fast-forward. Confirmed discard remains an unfinished M4 feature.

## Reviewed task commits

Stage the task's saved changes using Git in its worktree, stop its writers, and save or revert unsaved task editor buffers. Select **Prepare commit review** in Changes. Hydra requires no unstaged or untracked files, conflicts, active merge/rebase/cherry-pick, or skip-worktree/assume-unchanged entries. Ignored files stay excluded. The prepared tree includes earlier task commits and staged changes, compared with the recorded task base. Reviews above 1,000 changed files require a smaller task.

Each **Review snapshot** opens the immutable base and prepared tree objects, including rename/deletion sides and binary metadata. Neither later disk edits nor restaging alter that comparison. Enter a commit message, then select **Commit reviewed tree** to explicitly record acceptance of the full prepared tree. Merely opening snapshots does not accept it. Hydra rechecks the task branch, HEAD, tree, index fingerprint, writer ownership, and dirty buffers before committing. A stale or consumed token requires a fresh review; tokens expire on reload and writer launch.

The native Git commit uses a private copy of the prepared index. Original staging is retained, Git identity/signing and hooks still apply, and hooks are never bypassed. A successful unchanged tree naturally makes the original staging clean against its new HEAD. Already-committed trees record their current commit without creating an empty commit. Failure leaves the original index intact and removes the private index. Hooks can edit files or create a different commit through normal Git behavior: Hydra does not roll those changes back and refuses a reviewed receipt unless the resulting tree, parent, branch, index, and saved state still match. Inspect the checkout and prepare a fresh review after such a refusal.

The local task store persists an immutable receipt containing commit, tree, task base, and review time. It is historical evidence; later edits or commits do not become approved through that receipt. Integration verifies the current task state against it before preparing or promoting a candidate. The reviewed-commit step makes no model request, promotes no target branch, and preserves dirty main-checkout changes. It does not prevent manually launched external Git writers.

Validation uses real Git repositories with dirty main checkouts, Unicode paths, each Git layer, canceled staged changes, renames/deletions, binary/attribute/encoding/size limits, gitlinks, symlinks/junctions, and conflicts. Actual Windows VS Code host tests assert native diff documents and their contents, fixed snapshots after disk edits, binary notice behavior, preservation of unsaved buffers, and unchanged provider request logs. Manual accessibility/layout review remains pending.

Public sources: [Git diff](https://git-scm.com/docs/git-diff), [VS Code virtual documents](https://code.visualstudio.com/api/extension-guides/virtual-documents), and [VS Code built-in commands](https://code.visualstudio.com/api/references/commands).
