import { admitAutoDelegation } from './autoDelegationAdmission';
import { digest } from './delegationContext';
import type { PreparedDelegation } from './delegationPlan';
import type { DelegationPlannerRun } from './delegationPlannerIngestion';
import type { Task } from './model';

export interface AutoDelegationDispatchHost {
  tasks(): Task[];
  materialize(parentId: string, runId: string): PromiseLike<Task[]>;
  enroll(parentId: string, runId: string): PromiseLike<Task[]>;
  enqueue(child: Task): Promise<void>;
}

/** Replays only a saved, accepted Auto decision. Every side effect uses the
 * existing durable materialization, enrollment, and scheduler boundaries. */
export async function dispatchAcceptedAutoDelegation(
  parent: Task, decisions: PreparedDelegation[], host: AutoDelegationDispatchHost
): Promise<void> {
  const receipt: DelegationPlannerRun | undefined = parent.delegationPlanner;
  if (!receipt || receipt.state !== 'accepted' || receipt.preferences.mode !== 'auto' || parent.state === 'discarded') return;
  if (decisions.length !== 1 || decisions[0]?.proposal.id !== receipt.proposalId || decisions[0]?.proposal.runId !== receipt.runId) {
    throw new Error('Accepted Auto decision does not match its durable delegation run.');
  }
  const decision = decisions[0]!;
  if (typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.sha256 !== digest(JSON.stringify(decision.proposal))) {
    throw new Error('Accepted Auto decision does not match its planner receipt digest.');
  }
  const admission = admitAutoDelegation({ proposal: decision.proposal, policy: decision.mode === 'auto' ? receipt.policy : { ...receipt.policy, mode: decision.mode }, parent, preferences: receipt.preferences });
  if (admission.status === 'solo') return;
  if (admission.status !== 'eligible') throw new Error(`Accepted Auto decision is blocked: ${admission.rationale}`);

  const children = await host.materialize(parent.id, receipt.runId);
  if (children.length !== decision.proposal.children.length) throw new Error('Materialized child count differs from the accepted Auto decision.');
  const current = () => children.map(child => {
    const saved = host.tasks().find(task => task.id === child.id && task.delegation?.dispatchKey === child.delegation?.dispatchKey);
    if (!saved || saved.delegationJournalPending) throw new Error('Delegated child assignment is not durably recovered.');
    return saved;
  });
  let saved = current();
  if (saved.every(child => !child.schedule)) {
    await host.enroll(parent.id, receipt.runId);
    saved = current();
  }
  if (saved.some(child => !child.schedule)) throw new Error('Delegated child enrollment is incomplete.');
  for (const child of saved) {
    // Cancellation, interruption, and uncertain writers require explicit owner
    // reconciliation. A queued request is already durable and must not replay.
    if (child.schedule?.state !== 'enrolled') continue;
    await host.enqueue(child);
  }
}
