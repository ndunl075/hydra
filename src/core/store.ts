import { validateSchedule } from './scheduler';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { replaceAtomic } from './atomicFile';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from './model';
import { buildTaskPrompt, parseBrief, parseHandoffSummary } from './taskContext';
import { parseModelSelection } from './modelSelection';
import { validateDiscardReceipt } from './discard';
import { validateDelegatedVerificationEvidence } from './delegationEvidence';
import { parseDelegationPlannerRun } from './delegationPlannerIngestion';
export class LocalStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<Task[]> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'tasks.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data = JSON.parse(raw) as { version: number; tasks: unknown[] };
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Unsupported Hydra task store. Original data has been retained.');
    const ids = new Set<string>();
    for (const value of data.tasks) {
      if (!value || typeof value !== 'object') throw new Error('Invalid task record.');
      const task = value as Task;
      if (!/^[a-f0-9]{12}$/.test(task.id) || ids.has(task.id) ||
        !['title', 'prompt', 'repository', 'worktree', 'branch', 'baseCommit', 'integrationTarget', 'createdAt', 'updatedAt'].every(key => typeof (task as unknown as Record<string, unknown>)[key] === 'string') ||
        !path.isAbsolute(task.repository) || !path.isAbsolute(task.worktree) || !/^[a-f0-9]{40,64}$/.test(task.baseCommit) ||
        !['claude', 'codex'].includes(task.provider) || !['interactive-cli', 'official-extension', 'managed-cli'].includes(task.interface) ||
        !['idle', 'external', 'running', 'interrupted', 'error', 'discarded'].includes(task.state) ||
        (task.sessionId !== undefined && (typeof task.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task.sessionId))) ||
        (task.providerVersion !== undefined && typeof task.providerVersion !== 'string') ||
        (task.sessionProvider !== undefined && !['claude', 'codex'].includes(task.sessionProvider))) throw new Error('Invalid task record. Original data has been retained.');
      ids.add(task.id);
      if (task.state === 'discarded') {
        validateDiscardReceipt(task.discard);
        if (task.interface === 'official-extension' || task.schedule?.request || task.schedule?.uncertain || task.schedule && ['queued', 'blocked', 'starting', 'running', 'waiting-for-approval'].includes(task.schedule.state)) throw new Error('Discarded task retains an active or uncertain writer. Original data has been retained.');
      } else if (task.discard !== undefined) throw new Error('Discard receipt requires a discarded task. Original data has been retained.');
      if (task.modelSelection !== undefined) {
        parseModelSelection(task.modelSelection);
      }
      if (task.brief !== undefined && buildTaskPrompt(parseBrief(task.brief)) !== task.prompt) throw new Error('Task brief and saved prompt disagree. Original data has been retained.');
      if (task.handoffSummary !== undefined) parseHandoffSummary(task.handoffSummary);
      if (task.contextLockedAt !== undefined && (typeof task.contextLockedAt !== 'string' || !Number.isFinite(Date.parse(task.contextLockedAt)))) throw new Error('Invalid task context lock.');
      if (task.schedule !== undefined) validateSchedule(task.schedule);
      if (task.delegation !== undefined) {
        const link = task.delegation;
        if (!link || typeof link !== 'object' || !/^[a-f0-9]{12}$/.test(link.parentId) || !/^[a-f0-9]{12}$/.test(link.runId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(link.childKey) || !/^[a-f0-9]{24}$/.test(link.dispatchKey) || !Array.isArray(link.dependencies) || link.dependencies.length > 8 || !link.dependencies.every(value => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value)) || new Set(link.dependencies).size !== link.dependencies.length || link.parentId === task.id || link.dependencies.includes(task.id)) throw new Error('Invalid delegated child task link. Original data has been retained.');
        if (task.schedule && (task.schedule.dependencies.length !== link.dependencies.length || task.schedule.dependencies.some((dependency, index) => dependency !== link.dependencies[index]))) throw new Error('Delegated child schedule does not match its immutable dependencies. Original data has been retained.');
        if (task.delegationJournalPending !== undefined) { const pending = task.delegationJournalPending.event; if (!task.delegationJournalPending || task.delegationJournalPending.version !== 1 || !pending || pending.version !== 1 || pending.kind !== 'assignment' || pending.id !== link.dispatchKey || !/^[a-f0-9]{24}$/.test(pending.id) || pending.parentId !== link.parentId || pending.runId !== link.runId || pending.from.kind !== 'task' || pending.from.taskId !== link.parentId || pending.to.kind !== 'task' || pending.to.taskId !== task.id || pending.provenance.producer !== 'host' || pending.provenance.recordId !== link.dispatchKey || typeof pending.occurredAt !== 'string' || !Number.isFinite(Date.parse(pending.occurredAt))) throw new Error('Invalid delegated journal recovery marker. Original data has been retained.'); }
        if (task.verificationEvidence !== undefined) validateDelegatedVerificationEvidence(task.verificationEvidence);
      } else if (task.verificationEvidence !== undefined || task.delegationJournalPending !== undefined) throw new Error('Only delegated child tasks can retain delegation evidence. Original data has been retained.');
      if (task.delegationPlanner !== undefined) {
        const planner = parseDelegationPlannerRun(task.delegationPlanner);
        if (planner.policy.parentId !== task.id || planner.policy.provider !== task.provider || planner.policy.level !== 0 || !planner.policy.approvedBases.includes(task.baseCommit) || JSON.stringify(planner.policy.modelSelection || null) !== JSON.stringify(task.modelSelection || null)) throw new Error('Invalid parent planner receipt. Original data has been retained.');
      }
      if (task.reviewedCommit !== undefined) {
        const record = task.reviewedCommit;
        if (!record || typeof record !== 'object' || ![record.commit, record.tree, record.baseCommit].every(value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)) || record.baseCommit !== task.baseCommit || typeof record.reviewedAt !== 'string' || !Number.isFinite(Date.parse(record.reviewedAt))) throw new Error('Invalid reviewed commit. Original data has been retained.');
      }
    }
    const pending = (data.tasks as Task[]).flatMap(task => task.delegationJournalPending ? [task.delegationJournalPending.event.id] : []); if (new Set(pending).size !== pending.length) throw new Error('Duplicate delegated journal recovery event. Original data has been retained.');
    return data.tasks as Task[];
  }
  save(tasks: Task[]): Promise<void> {
    const data = JSON.stringify({ version: 1, tasks }, null, 2);
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `tasks-${randomUUID()}.tmp`);
      await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
      await replaceAtomic(temporary, path.join(this.directory, 'tasks.json'));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
