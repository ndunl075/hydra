import type { Task } from './model';
import type { DependencyArtifact } from './scheduler';
import { git } from './git';
import { access } from 'node:fs/promises';

async function clean(task: Task): Promise<void> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const location = (await git(task.worktree, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim();
    if (await access(location).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Finish the active Git operation before dependency preparation.');
  }
  if ((await git(task.worktree, ['symbolic-ref', '--short', 'HEAD'])).trim() !== task.branch) throw new Error('Task branch changed.');
  if ((await git(task.worktree, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).trim()) throw new Error('Dependency preparation requires clean task worktrees. Preserve changes and retry explicitly.');
  const entries = await git(task.worktree, ['ls-files', '-v', '-z']);
  if (entries.split('\0').some(entry => entry && (entry[0] === 'S' || entry[0] !== entry[0]?.toUpperCase()))) throw new Error('Dependency preparation requires full worktrees without hidden index entries.');
}
export async function prepareScheduledTask(task: Task, tasks: Task[], guard: (task: Task) => Promise<void>): Promise<{ commit: string; artifacts: DependencyArtifact[] }> {
  if (task.state === 'discarded') throw new Error('Restore this discarded task before dependency preparation.');
  const artifacts: DependencyArtifact[] = [];
  for (const id of task.schedule?.dependencies || []) {
    const predecessor = tasks.find(item => item.id === id);
    if (!predecessor || predecessor.state === 'discarded' || predecessor.repository !== task.repository || !predecessor.reviewedCommit) throw new Error('Prerequisite has no available reviewed commit.');
    await guard(predecessor); await clean(predecessor);
    const receipt = predecessor.reviewedCommit;
    const pinned = task.schedule?.artifacts.find(a => a.taskId === id);
    if (pinned && (pinned.commit !== receipt.commit || pinned.tree !== receipt.tree)) throw new Error('Prerequisite review changed. Save dependencies again to explicitly accept its new result.');
    const head = (await git(predecessor.worktree, ['rev-parse', 'HEAD'])).trim();
    const tree = (await git(predecessor.worktree, ['rev-parse', 'HEAD^{tree}'])).trim();
    if (head !== receipt.commit || tree !== receipt.tree || receipt.baseCommit !== predecessor.baseCommit) throw new Error('Prerequisite no longer matches its reviewed commit. Review it again before retrying.');
    artifacts.push({ taskId: id, ...receipt });
  }
  await guard(task);
  let commit = (await git(task.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const start = artifacts.find(a => a.taskId === task.schedule?.startFromDependency);
  if (start && !task.schedule?.actualStartingCommit) {
    if (task.sessionId || commit !== task.baseCommit) throw new Error('Starting from a predecessor requires an unstarted task at its original base.');
    await clean(task);
    await git(task.worktree, ['merge-base', '--is-ancestor', commit, start.commit]);
    await guard(task);
    await git(task.worktree, ['merge', '--ff-only', '--no-edit', start.commit]);
    commit = (await git(task.worktree, ['rev-parse', 'HEAD'])).trim();
    if (commit !== start.commit) throw new Error('Starting commit changed during dependency preparation.');
    task.baseCommit = commit;
    task.reviewedCommit = undefined;
  }
  return { commit, artifacts };
}
