import { validateDelegatedVerificationEvidence, type DelegatedVerificationEvidence, type VerificationStatus } from './delegationEvidence';
import type { SessionView, Task, TaskFile } from './model';

export type FocusedLifecycle = 'queued' | 'running' | 'validating' | 'blocked' | 'completed' | 'interrupted' | 'unavailable';
export interface FocusedVerificationCheck { id: string; required: boolean; status: VerificationStatus; startedAt?: string; finishedAt: string; exitCode?: number | null; command?: { executable: string; args: string[] }; artifacts: { kind: 'log' | 'report' | 'screenshot'; label: string; path: string }[] }
export interface FocusedVerificationAttempt { number: number; checkedCommit: string; checkedTree: string; startedAt: string; finishedAt: string; checks: FocusedVerificationCheck[] }
export interface FocusedVerification { state: 'missing' | 'not-required' | 'passed' | 'blocked'; attempts: FocusedVerificationAttempt[]; required: number; passed: number; blockers: number }
export interface FocusedWorkspace { taskId: string; lifecycle: FocusedLifecycle; worktree: string; branch: string; session: 'active' | 'available' | 'external' | 'unavailable'; preview: 'unavailable'; settings: string; changes: TaskFile[]; verification: FocusedVerification }

/** Read-only graph projection: it never starts a process, preview, check, or model turn. */
export function focusedWorkspace(task: Task, files: TaskFile[], session?: SessionView): FocusedWorkspace {
  const lifecycle: FocusedLifecycle = task.schedule?.uncertain ? 'interrupted' : task.schedule?.state === 'blocked' ? 'blocked' : task.schedule?.state === 'queued' || task.schedule?.state === 'enrolled' ? 'queued' : task.state === 'running' ? 'running' : task.state === 'error' ? 'blocked' : task.state === 'interrupted' ? 'interrupted' : task.reviewedCommit ? 'completed' : 'unavailable';
  const verification = summarize(task.verificationEvidence), effective = session?.turns.at(-1)?.modelSettings?.effective;
  return { taskId: task.id, lifecycle: verification.blockers ? 'validating' : lifecycle, worktree: task.worktree, branch: task.branch, session: task.interface === 'official-extension' ? 'external' : session?.active ? 'active' : task.interface === 'managed-cli' ? 'available' : 'unavailable', preview: 'unavailable', settings: effective ? `${effective.model} · ${effective.effort || 'provider default'}` : 'Not acknowledged', changes: structuredClone(files), verification };
}
function summarize(evidence?: DelegatedVerificationEvidence): FocusedVerification {
  if (!evidence) return { state: 'missing', attempts: [], required: 0, passed: 0, blockers: 0 };
  // Snapshots can arrive from older/corrupt storage even if the primary store
  // normally validates them. The read-only view must fail closed, never index
  // an empty attempt list or reinterpret malformed evidence as a pass.
  try { validateDelegatedVerificationEvidence(evidence); }
  catch { return { state: 'blocked', attempts: [], required: 0, passed: 0, blockers: 1 }; }
  const attempts = evidence.attempts.map(attempt => ({ number: attempt.number, checkedCommit: attempt.checkedCommit, checkedTree: attempt.checkedTree, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, checks: attempt.checks.map(check => ({ id: check.id, required: check.required, status: check.status, ...(check.startedAt ? { startedAt: check.startedAt } : {}), finishedAt: check.finishedAt, ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}), ...(check.command ? { command: { executable: check.command.executable, args: [...check.command.args] } } : {}), artifacts: check.artifacts.map(artifact => ({ kind: artifact.kind, label: artifact.label, path: artifact.path })) })) }));
  const required = attempts.at(-1)!.checks.filter(check => check.required), passed = required.filter(check => check.status === 'passed' && check.exitCode === 0 && check.artifacts.length > 0).length;
  return { state: required.length === 0 ? 'not-required' : required.length === passed ? 'passed' : 'blocked', attempts, required: required.length, passed, blockers: required.length - passed };
}
