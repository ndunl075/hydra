import { createHash } from 'node:crypto';
import type { Approval, Task } from './model';
import type { PersistedApprovalPause } from './delegationHandoffProducer';

export interface DelegationApprovalPauseRecord extends PersistedApprovalPause { version: 1; }
const hex12 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const hex24 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const stamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

/** Only opaque approval identity enters the task record; details and provider messages stay out. */
export function captureDelegationApprovalPauses(task: Task, approvals: readonly Approval[], turnId: string | undefined, occurredAt = new Date().toISOString()): boolean {
  if (!task.delegation || task.schedule?.state !== 'waiting-for-approval' || !approvals.length) return false;
  if (!hex12(turnId) || !stamp(occurredAt)) throw new Error('An active saved turn and timestamp are required for a delegated approval pause.');
  const existing = task.delegationApprovalPauses || [], link = task.delegation;
  let changed = false;
  for (const approval of approvals) {
    if (!hex12(approval.id)) throw new Error('Invalid delegated approval identity.');
    const recordId = createHash('sha256').update(JSON.stringify([task.id, turnId, approval.id])).digest('hex').slice(0, 24);
    if (existing.some(item => item.recordId === recordId)) continue;
    if (existing.length >= 128) throw new Error('Delegated approval pause history is full; reconcile before recording more pauses.');
    existing.push({ version: 1, parentId: link.parentId, runId: link.runId, taskId: task.id, dispatchKey: link.dispatchKey, recordId, occurredAt, state: 'waiting-for-approval' });
    changed = true;
  }
  if (changed) task.delegationApprovalPauses = existing;
  return changed;
}

export function validateDelegationApprovalPauses(task: Task): void {
  const records = task.delegationApprovalPauses;
  if (records === undefined) return;
  const link = task.delegation;
  if (!link || !Array.isArray(records) || records.length > 128 || new Set(records.map(item => item?.recordId)).size !== records.length) throw new Error('Invalid delegated approval pause history. Original data was retained.');
  for (const item of records) {
    if (!item || Object.keys(item).length !== 8 || item.version !== 1 || item.parentId !== link.parentId || item.runId !== link.runId || item.taskId !== task.id || item.dispatchKey !== link.dispatchKey || !hex24(item.recordId) || !stamp(item.occurredAt) || item.state !== 'waiting-for-approval') throw new Error('Invalid delegated approval pause history. Original data was retained.');
  }
}
