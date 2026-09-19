import { assertCurrentParentReviewApproved, assertCurrentParentReviewInput, type DelegationParentReviewReceipt, type ParentReviewSource } from './delegationParentReview';
import type { Task } from './model';

export type AutoDelegationResultReadinessCode =
  | 'ready-for-integration-checks'
  | 'missing-child-delegation'
  | 'wrong-parent'
  | 'pending-writer'
  | 'missing-result'
  | 'result-source-mismatch'
  | 'missing-or-invalid-evidence'
  | 'stale-result'
  | 'parent-review-pending'
  | 'parent-review-rejected-or-stale';

/** A display-safe explanation derived from durable child facts. It is never an
 * integration operation or an approval to promote a candidate. */
export interface AutoDelegationResultReadiness {
  code: AutoDelegationResultReadinessCode;
  readyForIntegrationChecks: boolean;
  reason: string;
}

export interface AutoDelegationResultReadinessInput {
  parent: Pick<Task, 'id'>;
  child: Task;
  /** The durable result receipt and binding selected by the host for this child. */
  source?: ParentReviewSource;
  /** Durable parent decisions for this parent/run. */
  parentReviews?: readonly DelegationParentReviewReceipt[];
}

const pending = (task: Task): boolean => task.state === 'discarded' || task.state === 'running' || task.state === 'external' || task.state === 'error' || task.state === 'interrupted' || task.schedule?.uncertain === true || ['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-children', 'blocked', 'cancelled', 'interrupted'].includes(task.schedule?.state || '');

const blocked = (code: Exclude<AutoDelegationResultReadinessCode, 'ready-for-integration-checks'>, reason: string): AutoDelegationResultReadiness => ({ code, readyForIntegrationChecks: false, reason });
const ready = (): AutoDelegationResultReadiness => ({ code: 'ready-for-integration-checks', readyForIntegrationChecks: true, reason: 'The current child result, review boundary, verification evidence, and explicit parent approval match. Existing combined integration checks still decide acceptance.' });

function same(value: unknown, other: unknown): boolean {
  try { return JSON.stringify(value) === JSON.stringify(other); }
  catch { return false; }
}

/**
 * Projects whether one direct child has supplied the durable facts required to
 * start the existing combined integration checks. This pure function neither
 * prepares nor promotes an integration candidate.
 */
export function assessAutoDelegationResultReadiness(input: AutoDelegationResultReadinessInput): AutoDelegationResultReadiness {
  const link = input.child.delegation;
  if (!link) return blocked('missing-child-delegation', 'This task is not a delegated child, so no child result can be considered for the parent.');
  if (link.parentId !== input.parent.id) return blocked('wrong-parent', 'The child delegation belongs to a different parent.');
  if (pending(input.child)) return blocked('pending-writer', 'The child has an active, waiting, cancelled, failed, discarded, or uncertain writer state. Preserve its work and reconcile it before integration.');
  if (!input.source) return blocked('missing-result', 'No durable child result and binding were supplied for parent review.');

  const sourceLink = input.source.child.delegation;
  const sourceCommit = input.source.child.reviewedCommit;
  const childCommit = input.child.reviewedCommit;
  if (!sourceLink || sourceLink.parentId !== link.parentId || sourceLink.runId !== link.runId || sourceLink.childKey !== link.childKey || sourceLink.dispatchKey !== link.dispatchKey || input.source.binding.parentId !== link.parentId || input.source.binding.runId !== link.runId || input.source.binding.childKey !== link.childKey || input.source.binding.dispatchKey !== link.dispatchKey || !sourceCommit || !childCommit || input.source.binding.baseCommit !== childCommit.baseCommit || sourceCommit.commit !== childCommit.commit || sourceCommit.tree !== childCommit.tree || sourceCommit.baseCommit !== childCommit.baseCommit || !same(input.source.child.verificationEvidence, input.child.verificationEvidence)) {
    return blocked('result-source-mismatch', 'The supplied result source is not the current child review, delegation, and evidence boundary.');
  }

  try { assertCurrentParentReviewInput(input.source); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'The child result boundary cannot be verified.';
    if (/stale|result boundary|changed/i.test(reason)) return blocked('stale-result', reason);
    return blocked('missing-or-invalid-evidence', reason);
  }

  if (!input.parentReviews) return blocked('parent-review-pending', 'No durable parent review decision was supplied for this current child result.');
  try { assertCurrentParentReviewApproved(input.parentReviews, input.source); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'The parent review does not approve this result.';
    if (/requires one current/i.test(reason)) return blocked('parent-review-pending', reason);
    return blocked('parent-review-rejected-or-stale', reason);
  }
  return ready();
}
