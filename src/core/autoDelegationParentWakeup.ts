import type { Task } from './model';
import type { DelegationOrchestrationResultRecord } from './delegationOrchestrationJournal';
import type { DelegationParentReviewReceipt } from './delegationParentReview';
import { assessAutoDelegationResultReadiness } from './autoDelegationResultReadiness';
import { createAutoDelegationParentResume, type AutoDelegationParentResume } from './autoDelegationParentResume';
import { createHash } from 'node:crypto';

/** Only saved, current and explicitly approved results may wake the parent. */
export async function saveAutoDelegationParentWaiting(parent: Task, tasks: readonly Task[], save: (tasks: Task[]) => Promise<void>, hold: () => void): Promise<void> {
  if (!parent.schedule || parent.state !== 'idle' || !parent.sessionId || parent.sessionProvider !== parent.provider ||
    !['running', 'waiting-for-approval', 'finished'].includes(parent.schedule.state)) return;
  const candidate = structuredClone(parent);
  candidate.schedule!.state = 'waiting-for-children';
  candidate.schedule!.request = undefined;
  candidate.schedule!.queuedAt = undefined;
  candidate.schedule!.wakeupKey = undefined;
  candidate.schedule!.reason = 'Waiting for delegated child results and parent review.';
  try { await save(tasks.map(task => task.id === parent.id ? candidate : task)); }
  catch (error) { hold(); throw error; }
  Object.assign(parent, candidate);
}

export function prepareAutoDelegationParentWakeup(parent: Task, runId: string, expectedChildKeys: readonly string[], children: readonly Task[], records: readonly DelegationOrchestrationResultRecord[], reviews: readonly DelegationParentReviewReceipt[]): AutoDelegationParentResume {
  const enrolled = children.filter(child => child.delegation?.parentId === parent.id && child.delegation.runId === runId);
  if (!expectedChildKeys.length || enrolled.length !== expectedChildKeys.length || new Set(enrolled.map(child => child.delegation!.childKey)).size !== expectedChildKeys.length || enrolled.some(child => !expectedChildKeys.includes(child.delegation!.childKey))) return { status: 'blocked', reason: 'invalid-input', childKeys: expectedChildKeys.filter(key => !enrolled.some(child => child.delegation?.childKey === key)) };
  if (!enrolled.length || enrolled.some(child => !child.delegation || child.schedule?.state !== 'finished' || child.state === 'error' || child.state === 'interrupted' || child.state === 'discarded' || child.schedule.uncertain)) return { status: 'blocked', reason: 'failed-child', childKeys: enrolled.filter(child => child.schedule?.state !== 'finished' || child.state === 'error' || child.state === 'interrupted' || child.state === 'discarded' || child.schedule?.uncertain).map(child => child.delegation!.childKey) };
  for (const child of enrolled) {
    const link = child.delegation!;
    const matches = records.filter(record => record.binding.parentId === parent.id && record.binding.runId === runId && record.binding.childKey === link.childKey && record.binding.dispatchKey === link.dispatchKey);
    const readiness = assessAutoDelegationResultReadiness({ parent, child, ...(matches.length === 1 ? { source: { child, binding: matches[0]!.binding, result: matches[0]!.receipt } } : {}), parentReviews: reviews });
    if (!readiness.readyForIntegrationChecks) return { status: 'blocked', reason: 'invalid-input', childKeys: [link.childKey] };
  }
  const selected = records.filter(record => enrolled.some(child => child.delegation?.childKey === record.binding.childKey));
  const receiptSha256s = selected.map(record => record.receipt.sha256).sort();
  const wakeupKey = createHash('sha256').update(receiptSha256s.join('\n')).digest('hex');
  return createAutoDelegationParentResume({ wakeup: { version: 1, parentId: parent.id, runId, receiptSha256s, wakeupKey }, children: enrolled.map(child => ({ parentId: parent.id, runId, childKey: child.delegation!.childKey, dispatchKey: child.delegation!.dispatchKey, state: 'finished' })), results: selected });
}
