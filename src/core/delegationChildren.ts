import type { DelegationDispatch } from './delegationDispatch';
import type { PreparedDelegation } from './delegationPlan';
import type { Task } from './model';

/** Converts already-materialized worktrees into idle Hydra tasks. It never queues or launches them. */
export function createDelegatedChildren(parent: Task, decisions: PreparedDelegation[], dispatches: DelegationDispatch[], now = new Date().toISOString()): Task[] {
  const children = decisions.flatMap(decision => decision.manifests.map(manifest => ({ child: manifest.child, prompt: manifest.prompt, runId: decision.proposal.runId })));
  if (!children.length || new Set(children.map(item => item.child.key)).size !== children.length) throw new Error('Delegation children are missing or duplicate.');
  if (dispatches.length !== children.length || dispatches.some(dispatch => dispatch.status !== 'materialized' || !dispatch.worktree || !dispatch.branch)) throw new Error('Every child worktree must be materialized before creating Hydra child tasks.');
  const taskIds = new Map(dispatches.map(dispatch => [dispatch.childKey, dispatch.worktreeId]));
  return children.map(item => {
    const dispatch = dispatches.find(candidate => candidate.childKey === item.child.key)!;
    if (!dispatch || dispatch.parentId !== parent.id || dispatch.runId !== item.runId || dispatch.baseCommit !== item.child.baseCommit) throw new Error('Delegation dispatch does not match the recorded child plan.');
    const dependencies = item.child.dependencies.map(key => taskIds.get(key));
    if (dependencies.some(value => value === undefined)) throw new Error('Delegation child dependency is not materialized.');
    return { id: dispatch.worktreeId, title: `${parent.title}: ${item.child.key}`, prompt: item.prompt, repository: parent.repository, worktree: dispatch.worktree!, branch: dispatch.branch!, baseCommit: dispatch.baseCommit, integrationTarget: parent.integrationTarget, provider: item.child.provider, interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now, ...(item.child.modelSelection ? { modelSelection: item.child.modelSelection } : {}), delegation: { parentId: parent.id, runId: item.runId, childKey: item.child.key, dispatchKey: dispatch.dispatchKey, dependencies: dependencies as string[] } };
  });
}

/**
 * Binds persisted children to the shared scheduler without creating a launch
 * request. The caller must explicitly invoke a normal Hydra launch later.
 */
export function enrollDelegatedChildren(parent: Task, expected: Task[], persisted: Task[], now = new Date().toISOString()): Task[] {
  if (parent.state === 'discarded' || !expected.length || expected.length !== persisted.length) throw new Error('Delegated children must be materialized before scheduler enrollment.');
  const expectedByDispatch = new Map(expected.map(task => [task.delegation!.dispatchKey, task]));
  if (expectedByDispatch.size !== expected.length || new Set(persisted.map(task => task.delegation?.dispatchKey)).size !== persisted.length) throw new Error('Delegated child enrollment has duplicate dispatch identities.');
  for (const task of persisted) {
    const link = task.delegation, source = link && expectedByDispatch.get(link.dispatchKey);
    if (!link || !source || link.parentId !== parent.id || link.runId !== source.delegation!.runId || task.id !== source.id || task.repository !== parent.repository || task.worktree !== source.worktree || task.branch !== source.branch || task.baseCommit !== source.baseCommit || task.integrationTarget !== source.integrationTarget || task.provider !== source.provider || task.interface !== source.interface || task.prompt !== source.prompt || JSON.stringify(task.modelSelection) !== JSON.stringify(source.modelSelection) || task.state !== 'idle') throw new Error('Stored delegated child does not match its immutable materialization receipt. Reconcile it before enrollment.');
    if (link.childKey !== source.delegation!.childKey || link.dependencies.length !== source.delegation!.dependencies.length || link.dependencies.some((dependency, index) => dependency !== source.delegation!.dependencies[index])) throw new Error('Stored delegated child dependencies do not match the recorded plan. Reconcile them before enrollment.');
    if (task.schedule) {
      const schedule = task.schedule;
      const wasCancelledBeforeLaunch = schedule.state === 'cancelled' && !schedule.request && !schedule.uncertain && !schedule.startFromDependency && !schedule.queuedAt && !schedule.actualStartingCommit && !schedule.budgetHold && schedule.budgetWarnings === undefined && schedule.artifacts.length === 0;
      if ((!wasCancelledBeforeLaunch && schedule.state !== 'enrolled') || schedule.request || schedule.uncertain || schedule.startFromDependency || schedule.dependencies.length !== link.dependencies.length || schedule.dependencies.some((dependency, index) => dependency !== link.dependencies[index])) throw new Error('Delegated child is already scheduled differently. Stop and reconcile it before enrollment.');
    }
  }
  for (const task of persisted) {
    if (task.schedule?.state === 'enrolled') continue;
    const link = task.delegation!;
    task.schedule = { state: 'enrolled', dependencies: [...link.dependencies], artifacts: [], reason: 'Delegated child enrolled; launch it explicitly when ready.' };
    task.updatedAt = now;
  }
  return persisted;
}

/**
 * Cancels an enrollment before any scheduler request exists. Worktree, dispatch,
 * and dependency receipts remain intact so the owning run can be explicitly
 * re-enrolled later. This never invokes the provider or scheduler launch path.
 */
export function cancelDelegatedEnrollment(parent: Task, expected: Task[], persisted: Task[], now = new Date().toISOString()): Task[] {
  if (parent.state === 'discarded' || !expected.length || expected.length !== persisted.length) throw new Error('Delegated children must be materialized before cancelling enrollment.');
  const expectedByDispatch = new Map(expected.map(task => [task.delegation!.dispatchKey, task]));
  if (expectedByDispatch.size !== expected.length || new Set(persisted.map(task => task.delegation?.dispatchKey)).size !== persisted.length) throw new Error('Delegated child cancellation has duplicate dispatch identities.');
  for (const task of persisted) {
    const link = task.delegation, source = link && expectedByDispatch.get(link.dispatchKey), schedule = task.schedule;
    if (!link || !source || link.parentId !== parent.id || link.runId !== source.delegation!.runId || task.id !== source.id || task.repository !== parent.repository || task.worktree !== source.worktree || task.branch !== source.branch || task.baseCommit !== source.baseCommit || task.integrationTarget !== source.integrationTarget || task.provider !== source.provider || task.interface !== source.interface || task.prompt !== source.prompt || JSON.stringify(task.modelSelection) !== JSON.stringify(source.modelSelection) || task.state !== 'idle') throw new Error('Stored delegated child does not match its immutable materialization receipt. Reconcile it before cancelling enrollment.');
    if (link.childKey !== source.delegation!.childKey || link.dependencies.length !== source.delegation!.dependencies.length || link.dependencies.some((dependency, index) => dependency !== source.delegation!.dependencies[index])) throw new Error('Stored delegated child dependencies do not match the recorded plan. Reconcile them before cancelling enrollment.');
    if (!schedule || schedule.state !== 'enrolled' || schedule.request || schedule.uncertain || schedule.startFromDependency || schedule.queuedAt || schedule.actualStartingCommit || schedule.budgetHold || schedule.budgetWarnings !== undefined || schedule.artifacts.length !== 0 || schedule.dependencies.length !== link.dependencies.length || schedule.dependencies.some((dependency, index) => dependency !== link.dependencies[index])) throw new Error('Only an enrolled delegated child with no launch history can be cancelled. Stop and reconcile it before changing the delegation run.');
  }
  for (const task of persisted) {
    task.schedule = { state: 'cancelled', dependencies: [...task.delegation!.dependencies], artifacts: [], reason: 'Delegated enrollment cancelled before any provider launch. Re-enroll this recorded run explicitly to make it launchable again.' };
    task.updatedAt = now;
  }
  return persisted;
}
