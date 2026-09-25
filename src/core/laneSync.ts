import { copyFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitRun } from './git';
import type { Lane } from './lanes';
import type { LaneSyncView } from './model';

/**
 * Lane coordination (docs/Lanes_And_Planner_Plan.md, "Coordination"). Hydra warns
 * and never blocks, and everything here is deterministic git with no model calls:
 * each lane's current work becomes a snapshot commit, and `git merge-tree` says
 * which lanes would conflict with each other or with their target branch.
 */

/** Snapshot commits carry a fixed identity and date, so the same work always gives the same commit id. */
const snapshotIdentity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Hydra lane snapshot', GIT_AUTHOR_EMAIL: 'lanes@hydra.invalid', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Hydra lane snapshot', GIT_COMMITTER_EMAIL: 'lanes@hydra.invalid', GIT_COMMITTER_DATE: '1700000000 +0000',
};
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const oid = (text: string, what: string): string => {
  const value = text.trim();
  if (!sha.test(value)) throw new Error(`git gave no ${what}.`);
  return value;
};

/**
 * A lane's current work (committed, staged, unstaged and untracked, honouring
 * .gitignore) as a commit whose parent is its HEAD, without touching its real
 * index or files: everything goes through a temporary GIT_INDEX_FILE.
 *
 * The temporary index starts as a copy of the lane's own index when it has one
 * (so git's file-stat cache spares re-reading unchanged files), else from HEAD.
 */
export async function snapshotLane(worktree: string): Promise<{ head: string; snapshot: string; dirty: boolean }> {
  const head = oid(await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}']), 'HEAD');
  const index = path.join(tmpdir(), `hydra-lane-${process.pid}-${randomBytes(6).toString('hex')}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const stage = async () => { await git(worktree, ['add', '-A'], env); return oid(await git(worktree, ['write-tree'], env), 'tree'); };
    let tree: string | undefined;
    try {
      const real = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
      await copyFile(real, index);
      tree = await stage();
    } catch { /* no index yet, one being replaced, or one git can't use as a copy: start from HEAD */ }
    if (!tree) {
      await rm(index, { force: true });
      await git(worktree, ['read-tree', head], env);
      tree = await stage();
    }
    const snapshot = oid(await git(worktree, ['commit-tree', tree, '-p', head, '-m', 'Hydra lane snapshot'], { ...env, ...snapshotIdentity }), 'snapshot');
    // Uncommitted work (untracked files included) makes the snapshot's tree differ from HEAD's.
    const dirty = tree !== oid(await git(worktree, ['rev-parse', `${head}^{tree}`]), 'tree');
    return { head, snapshot, dirty };
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
    await rm(`${index}.lock`, { force: true }).catch(() => undefined);
  }
}

/** Paths that differ between two commits. */
export async function changedFiles(repository: string, from: string, to: string): Promise<string[]> {
  return (await git(repository, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'])).split('\0').filter(Boolean);
}

/**
 * Paths that would conflict if `a` and `b` were merged: [] when they merge
 * cleanly. `git merge-tree` exits 0 when clean and 1 with the conflicted paths
 * after the tree id; anything else is an error ("couldn't check").
 */
export async function mergeTreeConflicts(repository: string, a: string, b: string): Promise<string[]> {
  const result = await gitRun(repository, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b]);
  if (result.code === 0) return [];
  if (result.code !== 1) throw new Error(result.stderr.trim() || `git merge-tree exited with ${result.code}.`);
  const [tree, ...files] = result.stdout.split('\0');
  if (!tree || !sha.test(tree)) throw new Error('git merge-tree gave no tree.');
  return [...new Set(files.filter(Boolean))];
}

/** How many commits `targetTip` has that `laneHead` doesn't. */
export async function behindCount(repository: string, laneHead: string, targetTip: string): Promise<number> {
  const count = Number((await git(repository, ['rev-list', '--count', `${laneHead}..${targetTip}`])).trim());
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

/** The tip of a local branch, or undefined when it doesn't exist. `branch` must already be a validated name. */
export async function branchTip(repository: string, branch: string): Promise<string | undefined> {
  const result = await gitRun(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  return result.code === 0 && sha.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
}

export const syncIntervalMs = 10_000;
/** The most changed files a lane reports; a lane touching more is summarised by the first ones. */
export const changedFilesMax = 1000;
type SyncLane = Pick<Lane, 'id' | 'worktree' | 'baseCommit' | 'target' | 'repository' | 'state'>;

/**
 * One coordination pass over a window's open lanes, with a cache: a pair (or a
 * lane and its target tip) whose snapshots haven't changed isn't checked again.
 */
export class LaneSync {
  private pairs = new Map<string, string[]>();
  private targets = new Map<string, string[]>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(lanes: readonly SyncLane[]): Promise<Map<string, LaneSyncView>> {
    const checkedAt = this.now().toISOString();
    const results = new Map<string, LaneSyncView>();
    const snapshots = new Map<string, { head: string; snapshot: string; tip?: string }>();
    for (const lane of lanes) {
      const result: LaneSyncView = { changedFiles: [], conflicts: [], targetConflicts: [], behind: 0, dirty: false, checkedAt };
      results.set(lane.id, result);
      try {
        const { head, snapshot, dirty } = await snapshotLane(lane.worktree);
        result.dirty = dirty;
        const tip = await branchTip(lane.repository, lane.target);
        snapshots.set(lane.id, { head, snapshot, tip });
        // Measured from where the lane meets its target, so work brought in by
        // "Update from target" doesn't count as the lane's own.
        const base = tip ? (await gitRun(lane.repository, ['merge-base', tip, snapshot])).stdout.trim() : '';
        const files = await changedFiles(lane.repository, sha.test(base) ? base : lane.baseCommit, snapshot);
        result.changedFiles = files.slice(0, changedFilesMax);
        if (!tip) { result.error = `The target branch ${lane.target} no longer exists.`; continue; }
        result.behind = await behindCount(lane.repository, head, tip);
      } catch (error) { result.error = `Couldn't check this lane: ${describe(error)}`; }
    }
    const usedPairs = new Map<string, string[]>(), usedTargets = new Map<string, string[]>();
    // Against the target tip.
    for (const lane of lanes) {
      const snap = snapshots.get(lane.id), result = results.get(lane.id)!;
      if (!snap?.tip || result.error) continue;
      const key = `${snap.snapshot}|${snap.tip}`;
      try {
        const files = this.targets.get(key) ?? await mergeTreeConflicts(lane.repository, snap.snapshot, snap.tip);
        usedTargets.set(key, files); result.targetConflicts = files;
      } catch (error) { result.error = `Couldn't check against ${lane.target}: ${describe(error)}`; }
    }
    // Lane against lane. A merged lane's work is already in its target, so it is checked only against the target.
    const active = lanes.filter(lane => lane.state !== 'merged' && lane.state !== 'closed' && snapshots.has(lane.id));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i]!, b = active[j]!;
        const [snapA, snapB] = [snapshots.get(a.id)!.snapshot, snapshots.get(b.id)!.snapshot];
        const key = [snapA, snapB].sort().join('|');
        try {
          const files = this.pairs.get(key) ?? await mergeTreeConflicts(a.repository, snapA, snapB);
          usedPairs.set(key, files);
          if (!files.length) continue;
          results.get(a.id)!.conflicts.push({ laneId: b.id, files });
          results.get(b.id)!.conflicts.push({ laneId: a.id, files });
        } catch (error) {
          for (const [lane, other] of [[a, b], [b, a]] as const) results.get(lane.id)!.error ??= `Couldn't check against another lane (${other.id}): ${describe(error)}`;
        }
      }
    }
    // Keep only what this pass used, so the cache never outgrows the open lanes.
    this.pairs = usedPairs; this.targets = usedTargets;
    return results;
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
