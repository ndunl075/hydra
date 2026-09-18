import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Task, TaskFile } from './model';
import { git, gitBytes } from './git';
import { isInside, parseStatus, repositoryRoot } from './worktrees';
import { pendingSchedule } from './scheduler';

export interface DiscardReceipt {
  head: string; targetCommit: string; fingerprint: string; discardedAt: string;
  unmergedCommits: { commit: string; subject: string }[]; changes: TaskFile[];
}
export interface DiscardReview extends Omit<DiscardReceipt, 'discardedAt'> {
  token: string; taskId: string; createdAt: string;
}
export type DiscardGuard = () => Promise<void>;
const oid = /^[a-f0-9]{40,64}$/;

export function validateDiscardReceipt(value: unknown): asserts value is DiscardReceipt {
  const record = value as DiscardReceipt | undefined;
  if (!record || !oid.test(record.head) || !oid.test(record.targetCommit) ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) || typeof record.discardedAt !== 'string' || !Number.isFinite(Date.parse(record.discardedAt)) ||
    !Array.isArray(record.unmergedCommits) || record.unmergedCommits.length > 1000 || !record.unmergedCommits.every(item => item && oid.test(item.commit) && typeof item.subject === 'string' && item.subject.length <= 1000) ||
    !Array.isArray(record.changes) || record.changes.length > 1000 || !record.changes.every(item => item && typeof item.path === 'string' && item.path.length <= 4096 && !item.path.includes('\0') && !path.isAbsolute(item.path) && !item.path.split(/[\\/]/).includes('..') && typeof item.status === 'string' && item.status.length === 2)) {
    throw new Error('Invalid discard receipt. Original task data has been retained.');
  }
}

export function assertDiscardable(task: Task, tasks: Task[]): void {
  if (task.state === 'discarded' || task.discard) throw new Error('This task is already discarded. Restore it explicitly to continue.');
  if (task.state === 'running' || task.state === 'external' || task.interface === 'official-extension' || pendingSchedule(task) || task.schedule?.request) throw new Error('Stop task writers, acknowledge external handback, and cancel queued work or reconcile uncertain writers before discard.');
  if (tasks.some(item => item.state !== 'discarded' && item.id !== task.id && item.schedule?.dependencies.includes(task.id))) throw new Error('Another task depends on this result. Remove that dependency explicitly before discard.');
}

async function identity(task: Task): Promise<{ repository: string; worktree: string; head: string }> {
  const repository = await realpath(task.repository), worktree = await realpath(task.worktree);
  if (isInside(repository, worktree) || await repositoryRoot(worktree) !== worktree || await repositoryRoot(repository) !== repository) throw new Error('Discard requires the exact separate task checkout and owning repository.');
  const common = async (root: string) => realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (await common(repository) !== await common(worktree) || (await git(worktree, ['symbolic-ref', '--short', 'HEAD'])).trim() !== task.branch) throw new Error('Task worktree or branch identity changed. Restore its recorded identity before discard.');
  const head = (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  await git(worktree, ['merge-base', '--is-ancestor', task.baseCommit, head]);
  return { repository, worktree, head };
}

async function observe(task: Task): Promise<Omit<DiscardReview, 'token' | 'taskId' | 'createdAt'>> {
  const { repository, worktree, head } = await identity(task);
  const entries = await git(worktree, ['ls-files', '-v', '-z']);
  if (entries.split('\0').some(entry => entry && (entry[0] === 'S' || entry[0] !== entry[0]?.toUpperCase()))) throw new Error('Discard review requires a full checkout without hidden index entries. Checkout preserved.');
  if ((await git(worktree, ['ls-files', '--stage', '-z'])).split('\0').some(entry => entry.startsWith('160000 '))) throw new Error('Discard review for task submodules is not supported yet. Checkout preserved.');
  const targetCommit = (await git(repository, ['rev-parse', '--verify', `refs/heads/${task.integrationTarget}^{commit}`])).trim();
  const unmergedCommits = (await git(worktree, ['log', '--max-count=1001', '--format=%H%x09%s', `${targetCommit}..${head}`, '--'])).trim().split('\n').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); return { commit: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 1000) };
  });
  const status = await git(worktree, ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const changes = parseStatus(status);
  if (changes.length > 1000 || unmergedCommits.length > 1000) throw new Error('Discard review exceeds 1,000 files or commits. Preserve the checkout and split the task before retrying.');
  const hash = createHash('sha256');
  hash.update(JSON.stringify([task.id, repository, worktree, task.branch, task.baseCommit, task.integrationTarget, head, targetCommit, unmergedCommits, status]));
  const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  hash.update(await readFile(index));
  hash.update(await gitBytes(worktree, ['diff', '--binary', '--no-ext-diff', '--no-textconv', head, '--']));
  // Hash saved untracked content without following symbolic links. Ignored files
  // are retained in place and are never included in a destructive operation.
  let bytes = 0;
  for (const file of changes.filter(file => file.status === '??')) {
    const filename = path.resolve(worktree, file.path);
    if (!isInside(worktree, filename)) throw new Error('Discard review path escapes its checkout.');
    const info = await lstat(filename);
    hash.update(JSON.stringify([file.path, info.mode]));
    if (info.isSymbolicLink()) { hash.update(await readlink(filename)); continue; }
    if (!info.isFile() || !isInside(worktree, await realpath(filename))) throw new Error('Discard review encountered an unsupported file or escaping path. Checkout preserved.');
    for await (const chunk of createReadStream(filename)) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw new Error('Untracked discard review exceeds 64 MiB. Commit or exclude large files explicitly; the checkout is preserved.');
      hash.update(chunk);
    }
  }
  return { head, targetCommit, unmergedCommits, changes, fingerprint: hash.digest('hex') };
}

export async function prepareDiscard(task: Task, tasks: Task[], guard: DiscardGuard): Promise<DiscardReview> {
  assertDiscardable(task, tasks); await guard();
  const observed = await observe(task); await guard(); assertDiscardable(task, tasks);
  return { ...observed, taskId: task.id, token: randomBytes(12).toString('hex'), createdAt: new Date().toISOString() };
}

/** Retire only the durable task record. Every Git ref, checkout file and log stays in place. */
export async function confirmDiscard(task: Task, tasks: Task[], review: DiscardReview, guard: DiscardGuard, save: (records: Task[]) => Promise<void>): Promise<void> {
  if (review.taskId !== task.id) throw new Error('Discard review belongs to another task.');
  const fresh = await prepareDiscard(task, tasks, guard);
  if (fresh.fingerprint !== review.fingerprint) throw new Error('Task or target changed since discard review. Prepare a fresh review before confirming.');
  await guard(); assertDiscardable(task, tasks);
  const { token: _token, taskId: _id, createdAt: _created, ...evidence } = fresh;
  const stamp = new Date().toISOString();
  const next: Task = { ...task, state: 'discarded', discard: { ...evidence, discardedAt: stamp }, updatedAt: stamp };
  await save(tasks.map(item => item.id === task.id ? next : item));
  Object.assign(task, next);
}

export async function restoreDiscarded(task: Task, tasks: Task[], guard: DiscardGuard, save: (records: Task[]) => Promise<void>): Promise<void> {
  if (task.state !== 'discarded' || !task.discard) throw new Error('This task has not been discarded.');
  await guard();
  // Retained files may have been edited manually. Restoration grants no reviewed
  // acceptance to those changes and never submits a turn or requeues a request.
  await identity(task); await guard();
  const next: Task = { ...task, state: 'interrupted', discard: undefined, updatedAt: new Date().toISOString(), error: undefined };
  await save(tasks.map(item => item.id === task.id ? next : item));
  Object.assign(task, next);
}
