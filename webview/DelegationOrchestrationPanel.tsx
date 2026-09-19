import React from 'react';
import type { Snapshot, Task } from '../src/core/model';
import type { ReconciliationChild } from '../src/core/delegationReconciliation';

export interface OrchestrationChildView {
  id?: string;
  key: string;
  state: string;
  blocker?: string;
}

export interface OrchestrationRunView {
  runId: string;
  decision: 'solo' | 'delegate';
  rationale: string;
  coverage: 'available' | 'partial' | 'unavailable';
  children: OrchestrationChildView[];
}

const runKey = (parentId: string, runId: string) => `${parentId}:${runId}`;

function childState(task: Task): string {
  if (task.schedule?.state === 'enrolled') return 'Delegated - queued';
  if (task.schedule?.state === 'finished' && task.state === 'idle') return 'Execution complete - review needed';
  if (task.reviewedCommit && task.state === 'idle') return 'Validated - not integrated';
  if (task.schedule?.state === 'waiting-for-approval') return 'Waiting for approval';
  if (task.schedule?.state === 'blocked') return 'Blocked';
  return { running: 'Running', idle: 'Idle', external: 'External - unobserved', interrupted: 'Interrupted', error: 'Error', discarded: 'Discarded' }[task.state];
}

function blocker(task: Task, hasResult: boolean, reconciliation?: ReconciliationChild): string | undefined {
  if (task.state === 'error') return task.error || 'Child execution failed.';
  if (task.state === 'interrupted' || reconciliation?.restart === 'interrupted') return 'Child execution was interrupted.';
  if (task.schedule?.uncertain || reconciliation?.uncertainWriter) return 'Writer state is uncertain; reconcile before review.';
  if (task.schedule?.state === 'cancelled' || reconciliation?.cancelled) return 'Child dispatch was cancelled.';
  if (task.schedule?.state === 'blocked') return task.schedule.reason || 'A saved dependency or capacity gate blocks this child.';
  if (reconciliation?.budgetHold) return 'A recorded budget hold blocks dispatch.';
  if (!hasResult && task.schedule?.state === 'finished') return 'Execution finished without a recorded result receipt.';
  if (hasResult && !task.reviewedCommit) return 'Result receipt is waiting for verification.';
  return undefined;
}

/** A durable display projection only. It neither derives a result nor calls a provider. */
export function delegationOrchestrationPanelData(snapshot: Snapshot, parent: Task): OrchestrationRunView[] {
  if (parent.delegation) return [];
  const plans = snapshot.delegationPlans?.[parent.id] || [];
  const runIds = new Set([...plans.map(plan => plan.runId), ...snapshot.tasks.flatMap(task => task.delegation?.parentId === parent.id ? [task.delegation.runId] : [])]);
  return [...runIds].map(runId => {
    const plan = plans.find(item => item.runId === runId);
    const actual = snapshot.tasks.filter(task => task.delegation?.parentId === parent.id && task.delegation.runId === runId);
    const journal = snapshot.delegationOrchestration?.[runKey(parent.id, runId)];
    const reconciliation = snapshot.delegationReconciliation?.[runKey(parent.id, runId)];
    const planned = new Map((plan?.children || []).map(child => [child.key, child]));
    for (const task of actual) planned.delete(task.delegation!.childKey);
    const actualChildren: OrchestrationChildView[] = actual.map(task => ({ id: task.id, key: task.delegation!.childKey, state: childState(task), blocker: blocker(task, !!journal?.results.some(result => result.childKey === task.delegation!.childKey), reconciliation?.children.find(child => child.taskId === task.id)) }));
    const plannedChildren: OrchestrationChildView[] = [...planned.values()].map(child => ({ key: child.key, state: 'Not materialized', blocker: 'No durable child task was recorded.' }));
    const children = [...actualChildren, ...plannedChildren];
    return { runId, decision: plan?.decision || (children.length ? 'delegate' : 'solo'), rationale: plan?.rationale || 'No saved planning rationale is available for this durable run.', coverage: snapshot.delegationRunAccounting?.[runKey(parent.id, runId)]?.coverage || 'unavailable', children };
  });
}

export function DelegationOrchestrationPanel({ snapshot, parent, onSelect }: { snapshot: Snapshot; parent: Task; onSelect: (id: string) => void }) {
  const runs = delegationOrchestrationPanelData(snapshot, parent);
  if (!runs.length) return null;
  return <section className="delegation-orchestration" aria-label="Delegation orchestration">
    <header><div><span className="section-label">SAVED ORCHESTRATION</span><h3>Decision, delivery, and review state</h3></div><p>Read-only durable records. Opening a child does not contact a provider.</p></header>
    {runs.map(run => <article key={run.runId} className="delegation-orchestration-run">
      <div className="delegation-orchestration-summary"><strong>{run.decision === 'delegate' ? 'Delegated decision' : 'Solo decision'}</strong><span>Usage coverage: {run.coverage}</span></div>
      <p>{run.rationale}</p>
      <ul>{run.children.map(child => <li key={child.key}><div><code>{child.key}</code><strong>{child.state}</strong>{child.blocker && <small role="status">{child.blocker}</small>}</div>{child.id && <button className="secondary" onClick={() => onSelect(child.id!)}>Open child</button>}</li>)}</ul>
    </article>)}
  </section>;
}
