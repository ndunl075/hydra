import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { digest, id, key, record } from './delegationContext';
import type { PreparedDelegation } from './delegationPlan';
import { createWorktree } from './worktrees';

export interface DelegationDispatch {
  version: 1; parentId: string; runId: string; childKey: string; dispatchKey: string; worktreeId: string; baseCommit: string;
  status: 'reserved' | 'materialized' | 'uncertain'; createdAt: string; updatedAt: string; worktree?: string; branch?: string; error?: string;
}
interface DispatchRun { version: 1; parentId: string; runId: string; dispatches: DelegationDispatch[] }
export interface MaterializeDelegationInput { parentId: string; runId: string; repository: string; parentTitle: string; configuredRoot?: string; decisions: PreparedDelegation[] }
type WorktreeCreator = typeof createWorktree;
const maxBytes = 1024 * 1024;
function identity(parentId: string, runId: string, childKey: string, baseCommit: string) {
  const seed = JSON.stringify({ version: 1, parentId, runId, childKey, baseCommit });
  return { dispatchKey: digest(seed).slice(0, 24), worktreeId: digest(`worktree:${seed}`).slice(0, 12) };
}
function parseDispatch(value: unknown): DelegationDispatch {
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'dispatchKey', 'worktreeId', 'baseCommit', 'status', 'createdAt', 'updatedAt', 'worktree', 'branch', 'error']);
  if (item.version !== 1 || !['reserved', 'materialized', 'uncertain'].includes(item.status as string) || typeof item.dispatchKey !== 'string' || !/^[a-f0-9]{24}$/.test(item.dispatchKey) || typeof item.worktreeId !== 'string' || !/^[a-f0-9]{12}$/.test(item.worktreeId) || typeof item.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(item.baseCommit) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || (item.worktree !== undefined && (typeof item.worktree !== 'string' || !path.isAbsolute(item.worktree))) || (item.branch !== undefined && (typeof item.branch !== 'string' || !/^agent\/[a-z0-9-]+-[a-f0-9]{12}$/.test(item.branch))) || (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > 2000)) || (item.status === 'materialized' && (item.worktree === undefined || item.branch === undefined)) || (item.status !== 'materialized' && (item.worktree !== undefined || item.branch !== undefined))) throw new Error('Invalid delegation dispatch receipt. Original data was retained.');
  return { version: 1, parentId: id(item.parentId), runId: id(item.runId), childKey: key(item.childKey), dispatchKey: item.dispatchKey, worktreeId: item.worktreeId, baseCommit: item.baseCommit, status: item.status as DelegationDispatch['status'], createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.worktree === undefined ? {} : { worktree: item.worktree }), ...(item.branch === undefined ? {} : { branch: item.branch }), ...(item.error === undefined ? {} : { error: item.error }) };
}
/** Durable worktree reservations only. This class never launches a provider session or creates a Hydra task. */
export class DelegationDispatchStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly assertOwner: () => Promise<void>, private readonly worktrees: WorktreeCreator = createWorktree) {}
  private file(parentId: string, runId: string) { return path.join(this.directory, `dispatch-${id(parentId)}-${id(runId)}.json`); }
  private async read(parentId: string, runId: string): Promise<DispatchRun> {
    const file = this.file(parentId, runId); let data: unknown;
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid delegation dispatch storage. Original data was retained.'); const bytes = await readFile(file); if (bytes.length > maxBytes) throw new Error('Delegation dispatch storage exceeds its size bound.'); data = JSON.parse(bytes.toString('utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, parentId, runId, dispatches: [] }; throw error; }
    const input = record(data, ['version', 'parentId', 'runId', 'dispatches']);
    if (input.version !== 1 || input.parentId !== parentId || input.runId !== runId || !Array.isArray(input.dispatches) || input.dispatches.length > 8) throw new Error('Invalid delegation dispatch run. Original data was retained.');
    const dispatches = input.dispatches.map(parseDispatch);
    if (new Set(dispatches.map(item => item.childKey)).size !== dispatches.length || new Set(dispatches.map(item => item.dispatchKey)).size !== dispatches.length || dispatches.some(item => item.parentId !== parentId || item.runId !== runId)) throw new Error('Invalid delegation dispatch run. Original data was retained.');
    return { version: 1, parentId, runId, dispatches };
  }
  private async save(run: DispatchRun, lock?: { file: string; token: string }): Promise<void> {
    const file = this.file(run.parentId, run.runId), content = JSON.stringify(run, null, 2);
    if (Buffer.byteLength(content) > maxBytes) throw new Error('Delegation dispatch storage exceeds its size bound.');
    const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await this.assertOwner(); if (lock && await readFile(lock.file, 'utf8') !== lock.token) throw new Error('Delegation dispatch ownership changed; reconciliation is required.'); await replaceAtomic(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async load(parentId: string, runId: string): Promise<DelegationDispatch[]> { return structuredClone((await this.read(id(parentId), id(runId))).dispatches); }
  materialize(input: MaterializeDelegationInput): Promise<DelegationDispatch[]> {
    const parentId = id(input.parentId), runId = id(input.runId), children = input.decisions.flatMap(decision => decision.order.map(childKey => ({ child: decision.proposal.children.find(item => item.key === childKey)!, childKey })));
    if (!children.length) return Promise.resolve([]);
    if (children.length > 8 || new Set(children.map(item => item.childKey)).size !== children.length || typeof input.repository !== 'string' || !path.isAbsolute(input.repository) || typeof input.parentTitle !== 'string' || !input.parentTitle.trim() || input.parentTitle.length > 120) return Promise.reject(new Error('Invalid delegation materialization request.'));
    const operation = this.queue.then(async () => {
      await this.assertOwner(); await mkdir(this.directory, { recursive: true });
      const lock = { file: `${this.file(parentId, runId)}.lock`, token: randomUUID() };
      await writeFile(lock.file, lock.token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Delegation dispatch has another writer or a retained lock. Reconcile ownership before retrying.'); throw error; });
      try {
        const run = await this.read(parentId, runId);
        if (run.dispatches.length) { if (run.dispatches.some(item => item.status !== 'materialized')) throw new Error('Delegation worktree reservation is unresolved. Reconcile it before another materialization attempt.'); return structuredClone(run.dispatches); }
        const now = new Date().toISOString(); run.dispatches = children.map(({ child, childKey }) => ({ version: 1, parentId, runId, childKey, ...identity(parentId, runId, childKey, child.baseCommit), baseCommit: child.baseCommit, status: 'reserved' as const, createdAt: now, updatedAt: now }));
        await this.save(run, lock);
        for (const dispatch of run.dispatches) {
          await this.assertOwner(); const child = children.find(item => item.childKey === dispatch.childKey)!.child;
          try { const created = await this.worktrees(input.repository, `${input.parentTitle} ${child.key}`, dispatch.worktreeId, input.configuredRoot, child.baseCommit); dispatch.status = 'materialized'; dispatch.worktree = created.worktree; dispatch.branch = created.branch; dispatch.updatedAt = new Date().toISOString(); await this.save(run, lock); }
          catch (error) { dispatch.status = 'uncertain'; dispatch.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000); dispatch.updatedAt = new Date().toISOString(); await this.save(run, lock).catch(() => {}); throw new Error(`Delegation worktree for ${dispatch.childKey} is uncertain and will not be retried automatically. Reconcile it before continuing.`); }
        }
        return structuredClone(run.dispatches);
      } finally { if (await readFile(lock.file, 'utf8').catch(() => '') === lock.token) await unlink(lock.file); }
    });
    this.queue = operation.then(() => {}, () => {}); return operation;
  }
}
