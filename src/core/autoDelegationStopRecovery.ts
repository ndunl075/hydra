import type { DelegationReconciliationProjection, ReconciliationChild } from './delegationReconciliation';
import type { Task } from './model';

export type AutoDelegationWriterOwnership = 'owned' | 'unowned' | 'unknown';
export type AutoDelegationStopAction = 'none' | 'cancel-pending-dispatch' | 'stop-owned-writer' | 'hold-unowned-writer' | 'hold-uncertain-writer';

export interface AutoDelegationWriterOwnershipFact {
  taskId: string;
  ownership: AutoDelegationWriterOwnership;
}

export interface AutoDelegationStopRecoveryTarget {
  taskId: string;
  childKey?: string;
  action: AutoDelegationStopAction;
  reason: string;
}

export interface AutoDelegationStopRecoveryIntent {
  version: 1;
  parent: AutoDelegationStopRecoveryTarget;
  children: AutoDelegationStopRecoveryTarget[];
}

export interface AutoDelegationStopRecoveryInput {
  parent: Task;
  runId: string;
  tasks: Task[];
  reconciliation: DelegationReconciliationProjection;
  ownership: AutoDelegationWriterOwnershipFact[];
}

const activeScheduleStates = new Set(['starting', 'running', 'waiting-for-approval']);

function ownershipFor(taskId: string, facts: AutoDelegationWriterOwnershipFact[]): AutoDelegationWriterOwnership {
  const matches = facts.filter(fact => fact.taskId === taskId);
  if (matches.length > 1 || !matches.length) return 'unknown';
  return matches[0]!.ownership;
}

function activeWriter(task: Task): boolean {
  return task.state === 'running' || (task.state === 'external' && task.interface === 'interactive-cli') || !!task.schedule && activeScheduleStates.has(task.schedule.state);
}

function writerIntent(task: Task, ownership: AutoDelegationWriterOwnership, childKey?: string): AutoDelegationStopRecoveryTarget {
  if (task.schedule?.uncertain || task.delegationExecution?.status === 'uncertain') {
    return { taskId: task.id, childKey, action: 'hold-uncertain-writer', reason: 'Writer recovery is uncertain. Keep its reservation held until explicit reconciliation.' };
  }
  if (!activeWriter(task)) return { taskId: task.id, childKey, action: 'none', reason: 'No active writer requires a stop action.' };
  if (ownership === 'owned') return { taskId: task.id, childKey, action: 'stop-owned-writer', reason: 'An active writer is owned by this window and requires an explicit stop.' };
  return { taskId: task.id, childKey, action: 'hold-unowned-writer', reason: ownership === 'unowned' ? 'An active writer belongs to another owner and must remain held.' : 'Writer ownership is unknown and must remain held.' };
}

function childIntent(task: Task, reconciliation: ReconciliationChild, ownership: AutoDelegationWriterOwnership): AutoDelegationStopRecoveryTarget {
  if (reconciliation.uncertainWriter || reconciliation.restart === 'uncertain') {
    return { taskId: task.id, childKey: reconciliation.childKey, action: 'hold-uncertain-writer', reason: 'Restart recovery found an uncertain child writer. Do not retry or launch it.' };
  }
  if (reconciliation.pendingDispatch) {
    return { taskId: task.id, childKey: reconciliation.childKey, action: 'cancel-pending-dispatch', reason: 'A pending child dispatch must be cancelled before any later explicit scheduling decision.' };
  }
  return writerIntent(task, ownership, reconciliation.childKey);
}

/**
 * Produces stop/recovery instructions from already-durable facts. It does not
 * mutate tasks, call an ownership lock, cancel a dispatch, drain a scheduler,
 * terminate a process, or create a new launch request. Old result receipts are
 * intentionally irrelevant: only an explicit later scheduler action can launch.
 */
export function deriveAutoDelegationStopRecoveryIntent(input: AutoDelegationStopRecoveryInput): AutoDelegationStopRecoveryIntent {
  const { parent, runId, tasks, reconciliation, ownership } = input;
  if (!/^[a-f0-9]{12}$/.test(runId) || parent.delegation || !tasks.some(task => task.id === parent.id) || reconciliation.parentId !== parent.id || reconciliation.runId !== runId) throw new Error('Stop recovery requires the selected delegated parent run.');
  if (new Set(ownership.map(fact => fact.taskId)).size !== ownership.length || ownership.some(fact => !/^[a-f0-9]{12}$/.test(fact.taskId) || !['owned', 'unowned', 'unknown'].includes(fact.ownership))) throw new Error('Invalid writer ownership facts.');

  const children = tasks.filter(task => task.delegation?.parentId === parent.id && task.delegation.runId === runId);
  const reconciliationByTask = new Map(reconciliation.children.map(child => [child.taskId, child]));
  if (reconciliation.children.length !== children.length || reconciliation.children.some(child => !children.some(task => task.id === child.taskId && task.delegation!.childKey === child.childKey)) || reconciliationByTask.size !== reconciliation.children.length) throw new Error('Stop recovery requires complete direct-child reconciliation facts.');

  return structuredClone({
    version: 1,
    parent: writerIntent(parent, ownershipFor(parent.id, ownership)),
    children: children.map(task => childIntent(task, reconciliationByTask.get(task.id)!, ownershipFor(task.id, ownership)))
  });
}
