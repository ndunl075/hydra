import type { Task, SessionView } from './model';
import { summarizeUsage, type UsageSummary } from './usage';
import { BudgetHoldError } from './budgets';

export type DelegationUsageStage = 'planning' | 'child' | 'retry' | 'review' | 'validation';
export type UsageCoverage = 'available' | 'partial' | 'unavailable';

export interface DelegationRunUsageProjection {
  parentId: string;
  runId: string;
  total: UsageSummary;
  coverage: UsageCoverage;
  stages: Record<DelegationUsageStage, { usage: UsageSummary; coverage: UsageCoverage }>;
}

/** A durable, local fence for one queued delegated child request. It is not a token or dollar estimate. */
export interface DelegationBudgetReservation {
  version: 1;
  parentId: string;
  runId: string;
  dispatchKey: string;
  request: 'startManaged' | 'followUp';
  acquiredAt: string;
}

export class DelegationBudgetReservationError extends BudgetHoldError {
  constructor() {
    super(['Another delegated sibling has a pending budget check. Wait for it to submit, cancel it, or reconcile its writer.']);
    this.name = 'DelegationBudgetReservationError';
  }
}

const stages: DelegationUsageStage[] = ['planning', 'child', 'retry', 'review', 'validation'];
const clone = <T>(value: T): T => structuredClone(value);

function coverage(summary: UsageSummary): UsageCoverage {
  if (!summary.recordedTurns && summary.tasksWithoutHistory > 0) return 'unavailable';
  if (!summary.recordedTurns) return 'unavailable';
  return summary.unmeasuredTurns || summary.tasksWithoutHistory ? 'partial' : 'available';
}

function inRun(task: Task, parentId: string, runId: string): boolean {
  return task.delegation?.parentId === parentId && task.delegation.runId === runId;
}

/**
 * Projects immutable persisted session histories for one direct parent/run. The
 * total is recomputed once across every included task, so cumulative provider
 * snapshots cannot be counted again when a run is resumed or displayed twice.
 * Parent turns are planning by default; callers may explicitly classify a
 * parent task as review/validation when they have a durable stage receipt.
 */
export function projectDelegationRunUsage(parent: Task, runId: string, tasks: Task[], view: (id: string) => SessionView | undefined, explicitStages: Partial<Record<string, DelegationUsageStage>> = {}): DelegationRunUsageProjection {
  if (!/^[a-f0-9]{12}$/.test(runId) || !tasks.some(task => task.id === parent.id)) throw new Error('Unknown delegation parent run.');
  const children = tasks.filter(task => inRun(task, parent.id, runId));
  const included = [parent, ...children];
  const taskStage = (task: Task): DelegationUsageStage => {
    const assigned = explicitStages[task.id];
    if (assigned && stages.includes(assigned)) return assigned;
    if (task.id === parent.id) return 'planning';
    return task.delegationRetry ? 'retry' : 'child';
  };
  const stageProjection = Object.fromEntries(stages.map(stage => {
    const selected = included.filter(task => taskStage(task) === stage).map(task => ({ taskId: task.id, session: view(task.id) }));
    const usage = summarizeUsage(selected);
    return [stage, { usage, coverage: coverage(usage) }];
  })) as DelegationRunUsageProjection['stages'];
  const total = summarizeUsage(included.map(task => ({ taskId: task.id, session: view(task.id) })));
  return { parentId: parent.id, runId, total, coverage: coverage(total), stages: stageProjection };
}

function validReservation(task: Task, reservation: DelegationBudgetReservation | undefined): reservation is DelegationBudgetReservation {
  const link = task.delegation;
  return !!reservation && reservation.version === 1 && !!link && reservation.parentId === link.parentId && reservation.runId === link.runId && reservation.dispatchKey === link.dispatchKey &&
    (reservation.request === 'startManaged' || reservation.request === 'followUp') && typeof reservation.acquiredAt === 'string' && Number.isFinite(Date.parse(reservation.acquiredAt));
}

function pending(task: Task): boolean {
  const state = task.schedule?.state;
  return state === 'queued' || state === 'starting' || state === 'running' || state === 'waiting-for-approval' || state === 'blocked';
}

/** Returns only current queued/in-flight reservations; finished/cancelled receipt views never retain a fence. */
export function pendingDelegationBudgetReservations(tasks: Task[], parentId: string, runId: string): DelegationBudgetReservation[] {
  return tasks.filter(task => inRun(task, parentId, runId) && pending(task) && validReservation(task, task.delegationBudgetReservation)).map(task => clone(task.delegationBudgetReservation!));
}

/**
 * Claims one sibling-local guard before a launch/turn budget check. The guard
 * has no amount and never predicts spend. A matching replay is idempotent.
 */
export function reserveDelegationBudget(task: Task, tasks: Task[], request: 'startManaged' | 'followUp', acquiredAt = new Date().toISOString()): DelegationBudgetReservation | undefined {
  if (!task.delegation) return undefined;
  const existing = task.delegationBudgetReservation;
  if (existing) {
    if (!validReservation(task, existing)) throw new Error('Invalid delegated budget reservation. Reconcile the task before retrying.');
    if (existing.request !== request) throw new Error('Delegated budget reservation belongs to a different request.');
    return clone(existing);
  }
  if (!Number.isFinite(Date.parse(acquiredAt))) throw new Error('Invalid delegated budget reservation time.');
  const conflict = tasks.some(sibling => sibling.id !== task.id && sibling.provider === task.provider && inRun(sibling, task.delegation!.parentId, task.delegation!.runId) && pending(sibling) && validReservation(sibling, sibling.delegationBudgetReservation));
  if (conflict) throw new DelegationBudgetReservationError();
  const reservation: DelegationBudgetReservation = { version: 1, parentId: task.delegation.parentId, runId: task.delegation.runId, dispatchKey: task.delegation.dispatchKey, request, acquiredAt };
  task.delegationBudgetReservation = reservation;
  return clone(reservation);
}

/** Releases only this task's validated reservation. A sibling's guard is never touched. */
export function releaseDelegationBudget(task: Task): boolean {
  if (!task.delegationBudgetReservation) return false;
  if (!validReservation(task, task.delegationBudgetReservation)) throw new Error('Invalid delegated budget reservation. Reconcile the task before retrying.');
  delete task.delegationBudgetReservation;
  return true;
}
