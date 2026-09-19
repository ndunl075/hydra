import type { Task } from './model';
import { overlappingScopes } from './delegationContext';
import { hostDelegationPolicy } from './delegationHost';
import { prepareDelegation, type DelegationPolicy, type DelegationProposal } from './delegationPlan';
import type { DelegationPreferences } from './delegationPreferences';

export type AutoDelegationAdmission =
  | { status: 'solo'; rationale: string }
  | { status: 'eligible'; rationale: string; proposal: DelegationProposal; policy: DelegationPolicy }
  | { status: 'blocked'; rationale: string };

export interface AutoDelegationAdmissionInput {
  proposal: unknown;
  policy: unknown;
  parent: Task;
  preferences: DelegationPreferences;
}

const publicReason = (error: unknown) => error instanceof Error && error.message.trim()
  ? error.message.slice(0, 240)
  : 'The saved delegation proposal could not be admitted.';

/**
 * Pure host admission for an already-saved proposal. It performs no dispatch,
 * task, worktree, process, or provider action.
 */
export function admitAutoDelegation(input: AutoDelegationAdmissionInput): AutoDelegationAdmission {
  let bound: ReturnType<typeof hostDelegationPolicy>;
  try {
    bound = hostDelegationPolicy(input.proposal, input.policy, input.parent, input.preferences);
  } catch (error) {
    return { status: 'blocked', rationale: publicReason(error) };
  }

  if (bound.proposal.decision === 'solo') {
    return { status: 'solo', rationale: bound.proposal.rationale };
  }
  if (bound.policy.mode === 'solo') {
    return { status: 'solo', rationale: 'Saved Solo preference keeps this parent work with one agent.' };
  }
  if (bound.proposal.children.length < 2) {
    return { status: 'solo', rationale: 'The proposal does not contain an independent split.' };
  }
  for (let index = 0; index < bound.proposal.children.length; index++) {
    const child = bound.proposal.children[index]!;
    if (bound.proposal.children.slice(index + 1).some(other => overlappingScopes(child.writeScope, other.writeScope))) {
      return { status: 'blocked', rationale: 'Child write scopes overlap and require one owner.' };
    }
  }
  try {
    prepareDelegation(bound.proposal, bound.policy);
  } catch (error) {
    return { status: 'blocked', rationale: publicReason(error) };
  }
  return { status: 'eligible', rationale: bound.proposal.rationale, proposal: bound.proposal, policy: bound.policy };
}
