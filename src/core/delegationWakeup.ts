import { createHash } from 'node:crypto';
import type { Task } from './model';
import type { ResultReceiptBinding, DelegationResultReceipt } from './delegationResults';
import { DelegationOrchestrationJournal } from './delegationOrchestrationJournal';
import { TaskScheduler } from './scheduler';

export interface ParentSuspension { parentId: string; runId: string; childIds: string[]; }
export interface WakeupOutcome { state: 'waiting' | 'woken' | 'blocked' | 'cancelled'; wakeupKey?: string; }

const failedChild = (task: Task) => task.state === 'error' || task.state === 'interrupted' || task.schedule?.state === 'cancelled' || task.schedule?.state === 'blocked' || task.schedule?.state === 'interrupted';
const key = (receipts: DelegationResultReceipt[]) => createHash('sha256').update(receipts.map(item => item.sha256).sort().join('\n')).digest('hex');

/**
 * Host-side result handoff only. Provider sessions are stopped by the supplied existing
 * session adapter before suspension; resumption is delegated to TaskScheduler.
 */
export class DelegationWakeup {
  /** `persist(candidate)` must durably save the supplied detached task before this class swaps it live. */
  constructor(private readonly journal: DelegationOrchestrationJournal, private readonly scheduler: TaskScheduler, private readonly persist: (candidate?: Task) => Promise<void>) {}

  async suspend(parent: Task, input: ParentSuspension, releaseSession: () => Promise<void>): Promise<void> {
    if (parent.id !== input.parentId || !/^[a-f0-9]{12}$/.test(input.runId) || !input.childIds.length || new Set(input.childIds).size !== input.childIds.length || !input.childIds.every(id => /^[a-f0-9]{12}$/.test(id)) || !parent.sessionId || parent.sessionProvider !== parent.provider || parent.interface !== 'managed-cli') throw new Error('Invalid parent suspension request.');
    if (parent.schedule?.state === 'waiting-for-children') return;
    if (!parent.schedule || !['running', 'waiting-for-approval'].includes(parent.schedule.state)) throw new Error('Parent has no active managed turn to suspend.');
    const previous = structuredClone(parent), candidate = structuredClone(parent);
    candidate.state = 'idle'; candidate.schedule!.state = 'waiting-for-children'; candidate.schedule!.request = undefined; candidate.schedule!.queuedAt = undefined; candidate.schedule!.reason = 'Waiting for delegated child results.'; candidate.schedule!.wakeupKey = undefined;
    await this.persist(candidate);
    Object.assign(parent, candidate);
    try { await releaseSession(); }
    catch (error) {
      // The provider process may still own the session. Restore the durable active state before returning.
      try { await this.persist(previous); Object.assign(parent, previous); }
      catch (compensationError) { throw new Error(`Parent session suspension failed and durable rollback also failed: ${String(compensationError)}`, { cause: error }); }
      throw error;
    }
  }

  async receive(value: unknown, binding: ResultReceiptBinding): Promise<DelegationResultReceipt> { return this.journal.appendResult(value, binding); }

  async reconcile(parent: Task, runId: string, children: Task[]): Promise<WakeupOutcome> {
    if (parent.state === 'discarded' || parent.schedule?.state === 'cancelled') return { state: 'cancelled' };
    if (parent.schedule?.state !== 'waiting-for-children') return parent.schedule?.wakeupKey ? { state: 'woken', wakeupKey: parent.schedule.wakeupKey } : { state: 'waiting' };
    const delegated = children.filter(child => child.delegation?.parentId === parent.id && child.delegation.runId === runId);
    if (!delegated.length) throw new Error('Parent has no enrolled delegated children for this run.');
    const projection = await this.journal.load(parent.id, runId);
    if (delegated.some(failedChild)) {
      const candidate = structuredClone(parent);
      candidate.schedule!.state = 'blocked'; candidate.schedule!.reason = 'A delegated prerequisite failed, was interrupted, or was cancelled. Recorded sibling results are retained.';
      await this.persist(candidate); Object.assign(parent, candidate); return { state: 'blocked' };
    }
    const receipts = projection.results.filter(receipt => delegated.some(child => child.delegation?.childKey === receipt.childKey));
    if (!receipts.length) return { state: 'waiting' };
    const wakeupKey = key(receipts);
    const prompt = ['Delegated child results are ready. Review the durable receipts before continuing:', ...receipts.sort((a, b) => a.childKey.localeCompare(b.childKey)).map(item => `- ${item.childKey}: ${item.summary} (receipt ${item.sha256})`)].join('\n');
    await this.scheduler.resumeWaitingParent(parent, prompt, wakeupKey);
    return { state: 'woken', wakeupKey };
  }

  /** Persist before invoking the existing scheduler retry path; replanning cannot erase it. */
  async retryChildOnce(child: Task, retry: () => Promise<void>): Promise<void> {
    if (!child.delegation) throw new Error('Only a delegated child can be retried.');
    if (child.delegationRetry) throw new Error('This delegated child already used its one automatic retry for this run.');
    child.delegationRetry = { version: 1, parentId: child.delegation.parentId, runId: child.delegation.runId, dispatchKey: child.delegation.dispatchKey, attemptedAt: new Date().toISOString() };
    try { await this.persist(child); } catch (error) { child.delegationRetry = undefined; throw error; }
    await retry();
  }
}
