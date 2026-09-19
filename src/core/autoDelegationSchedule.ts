import type { DelegationDispatch } from './delegationDispatch';
import type { PreparedDelegation } from './delegationPlan';

export type AutoDelegationScheduleState = 'ready' | 'waiting-for-predecessors';

/**
 * A host-owned projection that can be persisted and later submitted to the
 * scheduler. Creating it neither changes a task schedule nor starts a writer.
 */
export interface AutoDelegationScheduleIntent {
  version: 1;
  childId: string;
  dispatchKey: string;
  parentId: string;
  runId: string;
  childKey: string;
  baseCommit: string;
  predecessorIds: string[];
  state: AutoDelegationScheduleState;
  request: { type: 'startManaged' };
}

/**
 * Turns a host-validated plan and its durable, materialized worktree receipts
 * into immutable scheduling intents. The shared TaskScheduler remains the only
 * component that may queue, prepare, or launch these requests.
 */
export function createAutoDelegationScheduleIntents(decisions: PreparedDelegation[], dispatches: DelegationDispatch[]): AutoDelegationScheduleIntent[] {
  const planned = decisions.flatMap(decision => decision.order.map(childKey => {
    const child = decision.proposal.children.find(candidate => candidate.key === childKey);
    if (!child) throw new Error('Prepared delegation order does not match its validated children.');
    return { parentId: decision.proposal.parentId, runId: decision.proposal.runId, child };
  }));
  if (!planned.length || new Set(planned.map(item => `${item.parentId}:${item.runId}:${item.child.key}`)).size !== planned.length) throw new Error('Delegation schedule intents require unique prepared children.');
  if (dispatches.length !== planned.length || new Set(dispatches.map(item => item.dispatchKey)).size !== dispatches.length || new Set(dispatches.map(item => item.childKey)).size !== dispatches.length || new Set(dispatches.map(item => item.worktreeId)).size !== dispatches.length) throw new Error('Delegation schedule intents require one saved dispatch identity per child.');

  const dispatchByChild = new Map(dispatches.map(dispatch => [dispatch.childKey, dispatch]));
  const childIdByKey = new Map<string, string>();
  for (const item of planned) {
    const dispatch = dispatchByChild.get(item.child.key);
    if (!dispatch || dispatch.status !== 'materialized' || !dispatch.worktree || !dispatch.branch || dispatch.parentId !== item.parentId || dispatch.runId !== item.runId || dispatch.baseCommit !== item.child.baseCommit) throw new Error('Delegation dispatch is cancelled, uncertain, or does not match the validated child. Reconcile it before scheduling.');
    childIdByKey.set(item.child.key, dispatch.worktreeId);
  }

  return planned.map(item => {
    const dispatch = dispatchByChild.get(item.child.key)!;
    const predecessorIds = item.child.dependencies.map(key => childIdByKey.get(key));
    if (predecessorIds.some(id => id === undefined)) throw new Error('Delegation child predecessor is not materialized.');
    return {
      version: 1,
      childId: dispatch.worktreeId,
      dispatchKey: dispatch.dispatchKey,
      parentId: item.parentId,
      runId: item.runId,
      childKey: item.child.key,
      baseCommit: item.child.baseCommit,
      predecessorIds: predecessorIds as string[],
      state: predecessorIds.length ? 'waiting-for-predecessors' : 'ready',
      request: { type: 'startManaged' }
    };
  });
}
