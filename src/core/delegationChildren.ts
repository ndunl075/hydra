import { createHash } from 'node:crypto';
import type { DelegationDispatch } from './delegationDispatch';
import type { PreparedDelegation } from './delegationPlan';
import type { Task } from './model';

/** Converts already-materialized worktrees into idle Hydra tasks. It never queues or launches them. */
export function createDelegatedChildren(parent: Task, decisions: PreparedDelegation[], dispatches: DelegationDispatch[], now = new Date().toISOString()): Task[] {
  const children = decisions.flatMap(decision => decision.manifests.map(manifest => ({ child: manifest.child, prompt: manifest.prompt, runId: decision.proposal.runId })));
  if (!children.length || new Set(children.map(item => item.child.key)).size !== children.length) throw new Error('Delegation children are missing or duplicate.');
  if (dispatches.length !== children.length || dispatches.some(dispatch => dispatch.status !== 'materialized' || !dispatch.worktree || !dispatch.branch)) throw new Error('Every child worktree must be materialized before creating Hydra child tasks.');
  return children.map(item => {
    const dispatch = dispatches.find(candidate => candidate.childKey === item.child.key)!;
    if (!dispatch || dispatch.parentId !== parent.id || dispatch.runId !== item.runId || dispatch.baseCommit !== item.child.baseCommit) throw new Error('Delegation dispatch does not match the recorded child plan.');
    return { id: dispatch.worktreeId, title: `${parent.title}: ${item.child.key}`, prompt: item.prompt, repository: parent.repository, worktree: dispatch.worktree!, branch: dispatch.branch!, baseCommit: dispatch.baseCommit, integrationTarget: parent.integrationTarget, provider: item.child.provider, interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now, ...(item.child.modelSelection ? { modelSelection: item.child.modelSelection } : {}), delegation: { parentId: parent.id, runId: item.runId, childKey: item.child.key, dispatchKey: dispatch.dispatchKey } };
  });
}
