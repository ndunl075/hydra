import type { Task } from './model';
import { parseDelegationPolicy, parseDelegationProposal, type DelegationPolicy, type DelegationProposal } from './delegationPlan';
import type { DelegationPreferences } from './delegationPreferences';

/** Binds an untrusted proposal to the immutable facts of its owning Hydra task. */
export function hostDelegationPolicy(proposalValue: unknown, policyValue: unknown, parent: Task, preferences: DelegationPreferences): { proposal: DelegationProposal; policy: DelegationPolicy } {
  const proposal = parseDelegationProposal(proposalValue), policy = parseDelegationPolicy(policyValue);
  if (proposal.parentId !== parent.id || policy.parentId !== parent.id || policy.runId !== proposal.runId) throw new Error('Delegation proposal does not belong to this Hydra task.');
  if (policy.mode !== preferences.mode || policy.maxChildren !== preferences.maxChildren) throw new Error('Delegation policy does not match the current Hydra preference.');
  if (policy.level !== 0 || policy.provider !== parent.provider) throw new Error('Delegation policy does not match the parent execution boundary.');
  if (!policy.approvedBases.includes(parent.baseCommit) || proposal.children.some(child => child.baseCommit !== parent.baseCommit)) throw new Error('Delegation children must use the parent recorded base commit.');
  if (JSON.stringify(policy.modelSelection || null) !== JSON.stringify(parent.modelSelection || null)) throw new Error('Delegation policy does not inherit the parent model selection.');
  return { proposal, policy };
}
