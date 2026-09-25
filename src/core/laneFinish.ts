import { lstat, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { git, gitRun } from './git';
import { isInside } from './worktrees';
import { branchTip, mergeTreeConflicts } from './laneSync';
import { isLaneBranch, isSafeBranchName, laneFolder, type Lane } from './lanes';

/**
 * Finishing a lane (docs/Lanes_And_Planner_Plan.md, "Finishing a lane"): commit,
 * merge into its target, update from its target, push for a pull request, and
 * close. Every git write here runs only on an explicit user action; the caller
 * asks for confirmation where it matters. Refs and paths come only from a
 * validated lane record, never from raw input.
 */
type FinishLane = Pick<Lane, 'id' | 'name' | 'goal' | 'repository' | 'worktree' | 'branch' | 'target' | 'baseCommit' | 'state'>;

function assertLaneRefs(lane: FinishLane): void {
  if (!isLaneBranch(lane.branch, lane.id)) throw new Error(`Lane ${lane.name} has an invalid branch.`);
  if (!isSafeBranchName(lane.target)) throw new Error(`Lane ${lane.name} has an invalid target branch.`);
}
const firstLine = (text: string) => text.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';

/** Uncommitted changes in the lane, untracked files included. */
export async function laneDirty(lane: FinishLane): Promise<boolean> {
  return (await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all'])).trim().length > 0;
}
/** The branch the lane's worktree is on now, or undefined when it's detached. */
async function checkedOut(folder: string): Promise<string | undefined> {
  const result = await gitRun(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}
async function assertOnLaneBranch(lane: FinishLane): Promise<void> {
  const branch = await checkedOut(lane.worktree);
  if (branch !== lane.branch) throw new Error(`Lane ${lane.name} isn't on its branch ${lane.branch}. Check it out again in the lane first.`);
}

export const defaultCommitMessage = (lane: Pick<Lane, 'name' | 'goal'>): string => {
  const goal = firstLine(lane.goal || '');
  return (goal ? `${lane.name}: ${goal}` : lane.name).slice(0, 200);
};

/** `git add -A` then `git commit` in the lane, with the repository's identity or, if it has none, Hydra's. Undefined when there is nothing to commit. */
export async function commitLane(lane: FinishLane, message = defaultCommitMessage(lane)): Promise<string | undefined> {
  assertLaneRefs(lane);
  const text = message.trim();
  if (!text || text.length > 5000 || text.includes('\0')) throw new Error('The commit message must be 1–5000 characters.');
  await assertOnLaneBranch(lane);
  if (!await laneDirty(lane)) return undefined;
  await git(lane.worktree, ['add', '-A']);
  try { await git(lane.worktree, ['commit', '-q', '-m', text]); }
  catch (error) {
    if (!/tell me who you are|user\.email|user\.name|empty ident/i.test(String(error))) throw error;
    await git(lane.worktree, ['-c', 'user.name=Hydra lane', '-c', 'user.email=lanes@hydra.invalid', 'commit', '-q', '-m', text]);
  }
  return (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim();
}

export type MergeRefusal = 'nothing' | 'dirty' | 'wrongBranch' | 'conflicts' | 'noTarget';
export type MergeCheck =
  | { ok: true; commits: number; files: number }
  | { ok: false; reason: MergeRefusal; message: string; files?: string[] };

/**
 * Whether the lane can merge into its target now, and if so how much. Refused,
 * with the reason: nothing beyond the target, uncommitted changes, the main
 * checkout on another branch, or conflicts with the target.
 */
export async function checkMerge(lane: FinishLane): Promise<MergeCheck> {
  assertLaneRefs(lane);
  await assertOnLaneBranch(lane);
  const tip = await branchTip(lane.repository, lane.target);
  if (!tip) return { ok: false, reason: 'noTarget', message: `The target branch ${lane.target} no longer exists.` };
  const head = (await git(lane.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const commits = Number((await git(lane.repository, ['rev-list', '--count', `${tip}..${head}`])).trim()) || 0;
  if (!commits) return { ok: false, reason: 'nothing', message: 'Nothing to merge.' };
  if (await laneDirty(lane)) return { ok: false, reason: 'dirty', message: `Lane ${lane.name} has uncommitted changes. Commit them first.` };
  const main = await checkedOut(lane.repository);
  if (main !== lane.target) return { ok: false, reason: 'wrongBranch', message: `The main checkout is on ${main ?? 'a detached HEAD'}, not ${lane.target}. Switch it back to ${lane.target} to merge.` };
  const conflicts = await mergeTreeConflicts(lane.repository, head, tip);
  if (conflicts.length) return { ok: false, reason: 'conflicts', message: `Merging would conflict in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} (${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? ', …' : ''}). Update the lane from ${lane.target} first.`, files: conflicts };
  const base = (await git(lane.repository, ['merge-base', tip, head])).trim();
  const files = (await git(lane.repository, ['diff', '--name-only', '-z', '--no-renames', base, head, '--'])).split('\0').filter(Boolean).length;
  return { ok: true, commits, files };
}

/**
 * `git merge --no-ff --no-edit <branch>` in the main checkout, after checking
 * again. If git refuses (local changes in the way, for example), its message is
 * the error and nothing has changed: a merge git stopped halfway is aborted.
 */
export async function mergeLane(lane: FinishLane): Promise<string> {
  const check = await checkMerge(lane);
  if (!check.ok) throw new Error(check.message);
  const result = await gitRun(lane.repository, ['merge', '--no-ff', '--no-edit', lane.branch]);
  if (result.code !== 0) {
    if ((await gitRun(lane.repository, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0) await gitRun(lane.repository, ['merge', '--abort']);
    throw new Error(`git refused the merge: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 6).join(' ')}`);
  }
  return (await git(lane.repository, ['rev-parse', 'HEAD'])).trim();
}

/**
 * `git merge --no-edit <target>` in the lane. On conflicts the lane stays
 * mid-merge for the user to resolve, and the conflicted files come back.
 */
export async function updateLane(lane: FinishLane): Promise<{ conflicts: string[]; upToDate: boolean }> {
  assertLaneRefs(lane);
  await assertOnLaneBranch(lane);
  if (!await branchTip(lane.repository, lane.target)) throw new Error(`The target branch ${lane.target} no longer exists.`);
  const result = await gitRun(lane.worktree, ['merge', '--no-edit', lane.target]);
  if (result.code === 0) return { conflicts: [], upToDate: /already up to date/i.test(result.stdout) };
  const conflicts = (await git(lane.worktree, ['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
  if (conflicts.length) return { conflicts, upToDate: false };
  if (/local changes .* would be overwritten|commit your changes or stash them/is.test(result.stderr)) throw new Error(`The lane has uncommitted changes to files ${lane.target} also changed. Commit them first (⋯ → Commit…), then update.`);
  throw new Error(`git refused the update: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 6).join(' ')}`);
}

/** The GitHub compare page for a pushed branch, or undefined for any other remote. */
export function githubCompareUrl(remote: string, target: string, branch: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) return undefined;
  const ref = (name: string) => name.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${match[1]}/${match[2]}/compare/${ref(target)}...${ref(branch)}?expand=1`;
}

/** `git push -u origin <branch>` from the lane. Never prompts: a push that needs credentials git can't find fails with git's message. */
export async function pushLane(lane: FinishLane): Promise<{ branch: string; compareUrl?: string }> {
  assertLaneRefs(lane);
  await assertOnLaneBranch(lane);
  const remote = await gitRun(lane.worktree, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0) throw new Error('This repository has no "origin" remote to push to.');
  const pushed = await gitRun(lane.worktree, ['push', '-u', 'origin', `refs/heads/${lane.branch}:refs/heads/${lane.branch}`], { GIT_TERMINAL_PROMPT: '0' }, 180_000);
  if (pushed.code !== 0) throw new Error(`git couldn't push ${lane.branch}: ${(pushed.stderr.trim() || pushed.stdout.trim()).split('\n').slice(0, 6).join(' ')}`);
  const compareUrl = githubCompareUrl(remote.stdout, lane.target, lane.branch);
  return { branch: lane.branch, ...(compareUrl ? { compareUrl } : {}) };
}

/** The files a lane changed, against where it meets its target, for the multi-file diff. Uncommitted and untracked files included. */
export async function laneDiffFiles(lane: FinishLane, max = 300): Promise<{ base: string; files: { path: string; status: 'A' | 'M' | 'D' }[] }> {
  assertLaneRefs(lane);
  const tip = await branchTip(lane.repository, lane.target);
  const merged = tip ? (await gitRun(lane.worktree, ['merge-base', tip, 'HEAD'])).stdout.trim() : '';
  const base = /^[a-f0-9]{40,64}$/.test(merged) ? merged : lane.baseCommit;
  const files: { path: string; status: 'A' | 'M' | 'D' }[] = [];
  const parts = (await git(lane.worktree, ['diff', '--name-status', '-z', '--no-renames', base, '--'])).split('\0');
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index]!.charAt(0), file = parts[index + 1]!;
    if (file) files.push({ path: file, status: status === 'A' ? 'A' : status === 'D' ? 'D' : 'M' });
  }
  for (const file of (await git(lane.worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) files.push({ path: file, status: 'A' });
  return { base, files: files.slice(0, max) };
}

// ---- Closing and removal safety ----

const canonical = async (value: string): Promise<string> => {
  let resolved = path.resolve(value);
  try { resolved = await realpath(resolved); } catch { /* missing: compare as given */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Worktrees git has registered for this repository, the main checkout first. */
export async function registeredWorktrees(repository: string): Promise<string[]> {
  const listed = await git(repository, ['worktree', 'list', '--porcelain', '-z']);
  return listed.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
}

/**
 * Hydra removes a path only if it is a registered worktree of the lane's
 * repository (not the main checkout), a lane Hydra knows, and `lane-<id>`
 * directly under one of the worktree roots. Returns whether it still exists.
 */
export async function assertRemovableWorktree(lane: FinishLane, roots: readonly string[], known: readonly string[]): Promise<{ exists: boolean }> {
  assertLaneRefs(lane);
  const target = await canonical(lane.worktree);
  const refuse = (why: string) => { throw new Error(`Hydra won't remove ${lane.worktree}: ${why}`); };
  if (path.basename(lane.worktree) !== laneFolder(lane.id)) refuse('it isn\'t a lane worktree.');
  if (!(await Promise.all(known.map(canonical))).includes(target)) refuse('it isn\'t a lane Hydra knows.');
  const repository = await canonical(lane.repository);
  if (target === repository || isInside(target, repository) || isInside(repository, target)) refuse('it overlaps the main checkout.');
  const canonicalRoots = await Promise.all(roots.map(canonical));
  if (!canonicalRoots.some(root => path.dirname(target) === root)) refuse('it isn\'t in the worktree folder.');
  const info = await lstat(lane.worktree).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  // Already gone (deleted by hand): nothing to remove, only git's record to prune.
  if (!info) return { exists: false };
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('it isn\'t a folder.');
  const registered = await registeredWorktrees(lane.repository);
  const main = registered[0] ? await canonical(registered[0]) : undefined;
  if (target === main) refuse('it is the main checkout.');
  if (!(await Promise.all(registered.slice(1).map(canonical))).includes(target)) refuse('git doesn\'t list it as a worktree.');
  return { exists: true };
}

/**
 * Unlink every junction and symbolic link in a worktree (never following one)
 * before it is removed, so removal can never delete through a link such as a
 * linked node_modules. This is the lesson from 2026-09-24. Returns what was unlinked.
 */
export async function unlinkLinks(folder: string): Promise<string[]> {
  const unlinked: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      // Checked again with lstat: a reparse point must never be treated as a folder.
      const info = entry.isSymbolicLink() ? undefined : await lstat(full);
      if (entry.isSymbolicLink() || info?.isSymbolicLink()) {
        try { await unlink(full); } catch (error) { if (!['EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error; await rmdir(full); }
        unlinked.push(full);
      } else if (info?.isDirectory() && entry.name !== '.git') await visit(full);
    }
  };
  await visit(folder);
  return unlinked;
}

export type CloseMode = 'merged' | 'keep' | 'delete';

async function removeWorktree(lane: FinishLane, force: boolean): Promise<void> {
  const args = ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), lane.worktree];
  for (let attempt = 0; ; attempt++) {
    const result = await gitRun(lane.repository, args);
    if (result.code === 0) return;
    // "Not a working tree": a close racing another close found it already gone (done, not a
    // failure), or an earlier attempt unregistered it and then failed on a file still held open.
    // The path was checked to be this lane's worktree and its links are gone, so a retry removes
    // what's left (rm unlinks links, never follows them). A first attempt never deletes an
    // existing folder git doesn't know.
    if (/is not a working tree/i.test(result.stderr)) {
      const left = await lstat(lane.worktree).then(() => true, () => false);
      if (!left || attempt > 0) {
        if (left) await rm(lane.worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        await gitRun(lane.repository, ['worktree', 'prune']);
        return;
      }
    }
    // A process that just exited can hold files for a moment on Windows.
    if (attempt >= 3 || !/permission denied|unable to|busy|being used/i.test(result.stderr)) throw new Error(`git couldn't remove the worktree: ${result.stderr.trim().split('\n').slice(0, 4).join(' ')}`);
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
}

/**
 * Close a lane's worktree (its terminal must already be stopped):
 * - merged: `git worktree remove` (not forced), then `git branch -d`;
 * - keep: commit anything left as "WIP: <name>", remove the worktree, keep the branch;
 * - delete: force-remove the worktree, then `git branch -D`.
 * Links inside the worktree are unlinked first, and only a removable lane worktree is touched.
 */
export async function closeLaneWorktree(lane: FinishLane, mode: CloseMode, roots: readonly string[], known: readonly string[]): Promise<{ unlinked: string[] }> {
  const { exists } = await assertRemovableWorktree(lane, roots, known);
  let unlinked: string[] = [];
  if (exists) {
    if (mode === 'keep') await commitLane(lane, `WIP: ${lane.name}`);
    if (mode !== 'delete' && await laneDirty(lane)) throw new Error(`Lane ${lane.name} has uncommitted changes, so its worktree wasn't removed. Commit them or choose Delete everything.`);
    unlinked = await unlinkLinks(lane.worktree);
    await removeWorktree(lane, mode === 'delete');
  } else await gitRun(lane.repository, ['worktree', 'prune']);
  if (mode !== 'keep' && await branchTip(lane.repository, lane.branch)) {
    const deleted = await gitRun(lane.repository, ['branch', mode === 'delete' ? '-D' : '-d', lane.branch]);
    if (deleted.code !== 0) throw new Error(`The worktree is removed, but git kept the branch ${lane.branch}: ${deleted.stderr.trim().split('\n')[0]}`);
  }
  return { unlinked };
}

/** Merged, or nothing to lose: no commits beyond the target and no uncommitted changes. Such a lane closes without asking. */
export async function laneFullyMerged(lane: FinishLane): Promise<boolean> {
  assertLaneRefs(lane);
  const tip = await branchTip(lane.repository, lane.target);
  const head = await branchTip(lane.repository, lane.branch);
  if (!tip || !head) return false;
  if ((await gitRun(lane.repository, ['merge-base', '--is-ancestor', head, tip])).code !== 0) return false;
  try { return !await laneDirty(lane); } catch { return false; }
}
