import { digest, id, key } from './delegationContext';
import type { DelegationDispatch } from './delegationDispatch';
import type { DelegationGraphEvent } from './delegationGraphEvents';
import { DelegationOrchestrationJournal } from './delegationOrchestrationJournal';
import { parseDelegationResultReceipt, type DelegationResultReceipt, type ResultReceiptBinding } from './delegationResults';

/** Exact task/run identity retained by the host alongside every child source record. */
export interface DelegationHandoffChild {
  parentId: string;
  runId: string;
  taskId: string;
  childKey: string;
  dispatchKey: string;
}

/**
 * A task/approval transition which the caller has already saved. The producer
 * deliberately does not inspect a live session or navigate a view: extension
 * wiring must call this only after the saved task state is waiting for approval.
 */
export interface PersistedApprovalPause {
  parentId: string;
  runId: string;
  taskId: string;
  dispatchKey: string;
  recordId: string;
  occurredAt: string;
  state: 'waiting-for-approval';
}

const eventId = (kind: 'dispatch' | 'result-delivery' | 'approval-pause', parentId: string, runId: string, childId: string, recordId: string) =>
  digest(JSON.stringify({ version: 1, kind, parentId, runId, childId, recordId })).slice(0, 24);
const recordId = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new Error(`Invalid durable ${name} identity.`);
  return value;
};
const timestamp = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error(`Invalid durable ${name} timestamp.`);
  return value;
};
function child(value: DelegationHandoffChild): Required<DelegationHandoffChild> {
  return { parentId: id(value.parentId), runId: id(value.runId), taskId: id(value.taskId), childKey: key(value.childKey), dispatchKey: recordId(value.dispatchKey, 'dispatch') };
}

/**
 * Produces graph facts from already-durable host records. It owns neither a
 * dispatch, result, approval, task, nor session transition; a failed append
 * therefore leaves that source available for the caller to retry.
 */
export class DelegationHandoffProducer {
  constructor(private readonly journal: DelegationOrchestrationJournal) {}

  private async append(event: Omit<DelegationGraphEvent, 'sequence'>): Promise<DelegationGraphEvent> {
    // The journal's identity is durable and unique. Looking it up first makes
    // a replay a no-op even when the caller reaches it after a restart.
    const current = await this.journal.load(event.parentId, event.runId);
    const prior = current.events.find(item => item.id === event.id);
    if (prior) {
      const canonical = { ...prior } as Record<string, unknown>;
      delete canonical.sequence;
      if (JSON.stringify(canonical) !== JSON.stringify(event)) throw new Error('Conflicting durable handoff event identity.');
      return prior;
    }
    return this.journal.appendEvent(event);
  }

  /** Emit only after a loaded dispatch receipt reached its materialized state. */
  async dispatched(dispatch: DelegationDispatch, source: DelegationHandoffChild): Promise<DelegationGraphEvent> {
    const binding = child(source);
    if (dispatch.version !== 1 || dispatch.status !== 'materialized' || dispatch.parentId !== binding.parentId || dispatch.runId !== binding.runId || dispatch.childKey !== binding.childKey || dispatch.dispatchKey !== binding.dispatchKey) throw new Error('Materialized dispatch does not match the exact delegated child identity.');
    const occurredAt = timestamp(dispatch.updatedAt, 'dispatch');
    const durableId = recordId(dispatch.dispatchKey, 'dispatch');
    return this.append({ version: 1, id: eventId('dispatch', binding.parentId, binding.runId, binding.taskId, durableId), occurredAt, kind: 'dispatch', parentId: binding.parentId, runId: binding.runId, from: { kind: 'scheduler' }, to: { kind: 'task', taskId: binding.taskId }, provenance: { producer: 'scheduler', recordId: durableId } });
  }

  /** Emit only after the identical compact result receipt is present in the journal. */
  async delivered(value: unknown, binding: ResultReceiptBinding, source: DelegationHandoffChild, occurredAt: string): Promise<DelegationGraphEvent> {
    const identity = child(source), receipt = parseDelegationResultReceipt(value, binding);
    if (binding.parentId !== identity.parentId || binding.runId !== identity.runId || binding.childKey !== identity.childKey || binding.dispatchKey !== identity.dispatchKey || receipt.parentId !== identity.parentId || receipt.runId !== identity.runId || receipt.childKey !== identity.childKey || receipt.dispatchKey !== identity.dispatchKey) throw new Error('Result delivery does not match the exact delegated child identity.');
    const persisted = (await this.journal.load(identity.parentId, identity.runId)).results.find(item => item.sha256 === receipt.sha256);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(receipt)) throw new Error('Result delivery requires its exact durable journal receipt.');
    const deliveredAt = timestamp(occurredAt, 'result delivery');
    const durableId = digest(receipt.sha256).slice(0, 24);
    return this.append({ version: 1, id: eventId('result-delivery', identity.parentId, identity.runId, identity.taskId, durableId), occurredAt: deliveredAt, kind: 'result-delivery', parentId: identity.parentId, runId: identity.runId, from: { kind: 'task', taskId: identity.taskId }, to: { kind: 'task', taskId: identity.parentId }, provenance: { producer: 'host', recordId: durableId } });
  }

  /** Emit only after the caller has durably saved the child approval pause. */
  async pausedAfterApproval(source: DelegationHandoffChild, pause: PersistedApprovalPause): Promise<DelegationGraphEvent> {
    const identity = child(source), durableId = recordId(pause.recordId, 'approval pause'), occurredAt = timestamp(pause.occurredAt, 'approval pause');
    if (pause.state !== 'waiting-for-approval') throw new Error('Approval pause must follow a persisted waiting-for-approval transition.');
    if (id(pause.parentId) !== identity.parentId || id(pause.runId) !== identity.runId || id(pause.taskId) !== identity.taskId || recordId(pause.dispatchKey, 'approval dispatch') !== identity.dispatchKey) throw new Error('Persisted approval pause does not match the exact delegated child identity.');
    return this.append({ version: 1, id: eventId('approval-pause', identity.parentId, identity.runId, identity.taskId, durableId), occurredAt, kind: 'approval-pause', parentId: identity.parentId, runId: identity.runId, from: { kind: 'host' }, to: { kind: 'task', taskId: identity.taskId }, provenance: { producer: 'host', recordId: durableId } });
  }
}
