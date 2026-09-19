import type { DelegationDispatch } from './delegationDispatch';
import type { DelegationOrchestrationProjection } from './delegationOrchestrationJournal';
import type { Task } from './model';

export type ReconciliationAvailability = 'available' | 'unavailable';
export interface ReconciliationChild { taskId: string; childKey: string; pendingDispatch: boolean; uncertainWriter: boolean; cancelled: boolean; journalRecovery: boolean; budgetHold: boolean; restart: 'none' | 'interrupted' | 'uncertain'; }
export interface DelegationReconciliationProjection { parentId: string; runId: string; availability: ReconciliationAvailability; journal: ReconciliationAvailability; children: ReconciliationChild[]; }

/** Pure read-only projection. It never launches, reconciles, drains, creates, or mutates a task. */
export function projectDelegationReconciliation(parent: Task, runId: string, tasks: Task[], dispatches?: DelegationDispatch[], journal?: DelegationOrchestrationProjection): DelegationReconciliationProjection {
  if (!/^[a-f0-9]{12}$/.test(runId) || !tasks.some(task => task.id === parent.id) || parent.delegation) throw new Error('Unknown delegated parent run.');
  const children: ReconciliationChild[] = tasks.filter(task => task.delegation?.parentId === parent.id && task.delegation.runId === runId).map(task => {
    const link = task.delegation!, dispatch = dispatches?.find(item => item.parentId === parent.id && item.runId === runId && item.childKey === link.childKey && item.dispatchKey === link.dispatchKey), uncertainWriter = !!task.schedule?.uncertain || task.delegationExecution?.status === 'uncertain';
    return { taskId: task.id, childKey: task.delegation!.childKey, pendingDispatch: !dispatch || dispatch.status === 'reserved' || dispatch.status === 'uncertain', uncertainWriter, cancelled: task.schedule?.state === 'cancelled', journalRecovery: !!task.delegationJournalPending, budgetHold: !!task.schedule?.budgetHold || !!task.delegationBudgetReservation, restart: uncertainWriter ? 'uncertain' : task.state === 'interrupted' ? 'interrupted' : 'none' as const };
  });
  return structuredClone({ parentId: parent.id, runId, availability: dispatches === undefined ? 'unavailable' : 'available', journal: journal === undefined ? 'unavailable' : 'available', children });
}
