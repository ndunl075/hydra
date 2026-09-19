import type { DelegationDispatch } from './delegationDispatch';
import { DelegationHandoffProducer, type DelegationHandoffChild } from './delegationHandoffProducer';
import type { ResultReceiptBinding, DelegationResultReceipt } from './delegationResults';
import type { Task } from './model';

/**
 * Host adapter for Feature 29 graph facts. Callers must give it saved task,
 * dispatch, and result records; it never derives an edge from a view or a
 * live session.
 */
export class DelegationHandoffHost {
  constructor(private readonly producer: DelegationHandoffProducer) {}

  source(child: Pick<Task, 'id' | 'delegation'>): DelegationHandoffChild {
    const link = child.delegation;
    if (!link) throw new Error('A saved delegated child is required for a graph handoff.');
    return { parentId: link.parentId, runId: link.runId, taskId: child.id, childKey: link.childKey, dispatchKey: link.dispatchKey };
  }

  dispatched(dispatch: DelegationDispatch, child: Pick<Task, 'id' | 'delegation'>) {
    return this.producer.dispatched(dispatch, this.source(child));
  }

  delivered(receipt: DelegationResultReceipt, binding: ResultReceiptBinding, child: Pick<Task, 'id' | 'delegation'>, occurredAt: string) {
    return this.producer.delivered(receipt, binding, this.source(child), occurredAt);
  }
}
