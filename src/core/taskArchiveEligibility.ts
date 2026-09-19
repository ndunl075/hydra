import type { IntegrationOperation } from './integrationModel';
import type { Task } from './model';
import { pendingSchedule } from './scheduler';

export type ArchiveEvidenceState = 'complete' | 'pending' | 'unknown';
export type ArchiveOwnershipState = 'stopped' | 'active' | 'uncertain' | 'unknown';
export type ArchiveSavedState = 'clean' | 'dirty' | 'unsaved' | 'unknown';
export type ArchiveBlockerKind =
  | 'already-archived' | 'ownership-active' | 'ownership-uncertain' | 'ownership-unknown'
  | 'checkout-dirty' | 'unsaved-buffers' | 'checkout-unknown' | 'integration-unaccepted'
  | 'evidence-pending' | 'evidence-unknown' | 'dependent-task';

export interface ArchiveBlocker { kind: ArchiveBlockerKind; message: string; taskId?: string }
export interface ArchiveRecoveryRef { kind: 'task-branch' | 'integration-rollback'; ref: string; commit?: string }
export interface TaskArchiveRecoveryPreview {
  checkout: string;
  branch: string;
  reviewedCommit?: string;
  integrationTarget: string;
  retainedRefs: ArchiveRecoveryRef[];
}
export interface TaskArchiveEligibility {
  /** Advisory only. This module never deletes, moves, writes, or starts a process. */
  eligible: boolean;
  blockers: ArchiveBlocker[];
  recovery: TaskArchiveRecoveryPreview;
}
export interface TaskArchiveObservation {
  /** A host-bound saved checkout observation. Unknown is intentionally not assumed clean. */
  savedState: ArchiveSavedState;
  /** A host-bound writer ownership observation. Unknown is intentionally not assumed stopped. */
  ownership: ArchiveOwnershipState;
  /** Explicit retained evidence observation. Omission cannot imply completion. */
  evidence: ArchiveEvidenceState;
}

const accepted = (task: Task, op: IntegrationOperation): boolean => {
  const review = task.reviewedCommit;
  return !!review && op.taskId === task.id && op.phase === 'promoted' &&
    op.repository === task.repository && op.taskWorktree === task.worktree &&
    op.taskBranch === task.branch && op.baseCommit === task.baseCommit &&
    op.taskCommit === review.commit && op.taskTree === review.tree &&
    op.targetBranch === task.integrationTarget && !!op.candidateCommit && !!op.candidateTree &&
    !!op.rollbackRef && op.checks.length > 0 && op.checks.every(check => check.status === 'passed' && check.exitCode === 0 && !check.error);
};

const activeWriter = (task: Task) => task.state === 'running' || task.state === 'external' || task.interface === 'official-extension' || pendingSchedule(task);
const dependent = (task: Task, candidate: Task) => candidate.id !== task.id && candidate.state !== 'discarded' &&
  (candidate.schedule?.dependencies.includes(task.id) || candidate.delegation?.parentId === task.id && activeWriter(candidate));

/**
 * Builds a conservative, read-only archive recommendation from already-observed facts.
 * It deliberately does not inspect a checkout itself: callers must supply an explicit
 * saved-buffer/checkout observation so navigation cannot hide an unknown editor buffer.
 */
export function previewTaskArchiveEligibility(task: Task, tasks: readonly Task[], operations: readonly IntegrationOperation[], observation: TaskArchiveObservation): TaskArchiveEligibility {
  const blockers: ArchiveBlocker[] = [];
  const block = (kind: ArchiveBlockerKind, message: string, taskId?: string) => blockers.push({ kind, message, taskId });
  if (task.state === 'discarded') block('already-archived', 'This task is already retired; restore it before preparing another archive preview.');
  if (activeWriter(task) || observation.ownership === 'active') block('ownership-active', 'Stop task writers and queued work before archiving this checkout.');
  if (observation.ownership === 'uncertain') block('ownership-uncertain', 'Writer ownership is uncertain. Reconcile the writer before archiving this checkout.');
  if (observation.ownership === 'unknown') block('ownership-unknown', 'Writer ownership has not been observed as stopped.');
  if (observation.savedState === 'dirty') block('checkout-dirty', 'The saved checkout has tracked, staged, or untracked changes. Preserve or commit them before archiving.');
  if (observation.savedState === 'unsaved') block('unsaved-buffers', 'Unsaved editor buffers must be saved or reverted before archiving.');
  if (observation.savedState === 'unknown') block('checkout-unknown', 'Saved checkout state has not been observed; it is not assumed clean.');
  const matching = operations.filter(op => op.taskId === task.id);
  if (!matching.some(op => accepted(task, op))) block('integration-unaccepted', 'No matching promoted integration with passed acceptance evidence was retained.');
  if (matching.some(op => op.phase !== 'promoted')) block('evidence-pending', 'A task integration operation is still pending, conflicted, failed, or interrupted; retain it for recovery.');
  if (observation.evidence === 'pending') block('evidence-pending', 'Additional required evidence is pending.');
  if (observation.evidence !== 'complete' && observation.evidence !== 'pending') block('evidence-unknown', 'Additional evidence state is unknown and cannot be treated as complete.');
  for (const item of tasks.filter(item => dependent(task, item))) block('dependent-task', 'Another active task still depends on this task or child result.', item.id);
  const retainedRefs: ArchiveRecoveryRef[] = [{ kind: 'task-branch', ref: `refs/heads/${task.branch}`, commit: task.reviewedCommit?.commit }];
  for (const op of matching.filter(op => accepted(task, op) && op.rollbackRef)) retainedRefs.push({ kind: 'integration-rollback', ref: op.rollbackRef!, commit: op.targetCommit });
  return { eligible: blockers.length === 0, blockers, recovery: { checkout: task.worktree, branch: task.branch, reviewedCommit: task.reviewedCommit?.commit, integrationTarget: task.integrationTarget, retainedRefs } };
}
