import { assertDelegatedVerificationGate } from './delegationEvidence';
import type { Task } from './model';

const blocked = (task: Task): boolean => task.state === 'discarded' || task.state === 'running' || task.state === 'external' || task.state === 'error' || task.state === 'interrupted' || task.schedule?.uncertain === true || ['queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-children', 'blocked', 'cancelled', 'interrupted'].includes(task.schedule?.state || '');

/**
 * Refuses integration until every direct child of the parent has a current,
 * successful local verification record. This is deliberately a precondition:
 * the normal candidate checks still establish combined acceptance.
 */
export function delegationIntegrationGate(task: Task, tasks: readonly Task[]): void {
  const children = tasks.filter(child => child.delegation?.parentId === task.id);
  if (!children.length) {
    assertDelegatedVerificationGate(task);
    return;
  }
  for (const child of children) {
    if (blocked(child)) throw new Error(`Delegated prerequisite ${child.delegation!.childKey} is active, discarded, failed, interrupted, cancelled, waiting, queued, or uncertain. Preserve its work and reconcile it before integration.`);
    try { assertDelegatedVerificationGate(child); }
    catch (error) { throw new Error(`Delegated prerequisite ${child.delegation!.childKey} blocks combined acceptance: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
