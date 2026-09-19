import { assertDelegatedVerificationGate } from './delegationEvidence';
import { assertCurrentParentReviewApproved, type DelegationParentReviewReceipt, type ParentReviewSource } from './delegationParentReview';
import type { Task } from './model';

/** A host-loaded, durable review view. It is deliberately supplied by the host
 * because the two journals are asynchronous and the integration gate is a
 * synchronous precondition. */
export interface SavedParentReviewProjection {
  source: ParentReviewSource;
  receipts: readonly DelegationParentReviewReceipt[];
}
export interface DelegationIntegrationGateOptions {
  parentReviews?: readonly SavedParentReviewProjection[];
}

const blocked = (task: Task): boolean => task.state === 'discarded' || task.state === 'running' || task.state === 'external' || task.state === 'error' || task.state === 'interrupted' || task.schedule?.uncertain === true || ['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-children', 'blocked', 'cancelled', 'interrupted'].includes(task.schedule?.state || '');

/**
 * Refuses integration until every direct child of the parent has a current,
 * successful local verification record. This is deliberately a precondition:
 * the normal candidate checks still establish combined acceptance.
 */
export function delegationIntegrationGate(task: Task, tasks: readonly Task[], options: DelegationIntegrationGateOptions = {}): void {
  const children = tasks.filter(child => child.delegation?.parentId === task.id);
  if (!children.length) {
    assertDelegatedVerificationGate(task);
    return;
  }
  for (const child of children) {
    if (blocked(child)) throw new Error(`Delegated prerequisite ${child.delegation!.childKey} is active, discarded, failed, interrupted, cancelled, waiting, queued, or uncertain. Preserve its work and reconcile it before integration.`);
    try { assertDelegatedVerificationGate(child); }
    catch (error) { throw new Error(`Delegated prerequisite ${child.delegation!.childKey} blocks combined acceptance: ${error instanceof Error ? error.message : String(error)}`); }
    const matching = options.parentReviews?.filter(projection => {
      const source = projection.source.child.delegation;
      return source?.parentId === task.id && source.runId === child.delegation!.runId && source.childKey === child.delegation!.childKey;
    }) || [];
    if (matching.length !== 1) throw new Error(`Delegated prerequisite ${child.delegation!.childKey} blocks combined acceptance: one durable current parent review projection is required.`);
    try { assertCurrentParentReviewApproved(matching[0]!.receipts, matching[0]!.source); }
    catch (error) { throw new Error(`Delegated prerequisite ${child.delegation!.childKey} blocks combined acceptance: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
