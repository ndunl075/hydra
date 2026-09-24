/** Check outcome names as recorded by a verification attempt. */
export type VerificationStatus = string;
import type { SessionView, Task, TaskFile } from './model';

export type FocusedLifecycle = 'queued' | 'running' | 'validating' | 'blocked' | 'completed' | 'interrupted' | 'unavailable';
export interface FocusedVerificationCheck { id: string; required: boolean; status: VerificationStatus; startedAt?: string; finishedAt: string; exitCode?: number | null; command?: { executable: string; args: string[] }; artifacts: { kind: 'log' | 'report' | 'screenshot'; label: string; path: string }[] }
export interface FocusedVerificationAttempt { number: number; checkedCommit: string; checkedTree: string; startedAt: string; finishedAt: string; checks: FocusedVerificationCheck[] }
export interface FocusedVerification { state: 'missing' | 'not-required' | 'passed' | 'blocked'; attempts: FocusedVerificationAttempt[]; required: number; passed: number; blockers: number }
export interface FocusedWorkspace { taskId: string; lifecycle: FocusedLifecycle; worktree: string; branch: string; session: 'active' | 'available' | 'external' | 'unavailable'; preview: 'unavailable'; settings: string; changes: TaskFile[]; verification: FocusedVerification }

/** Read-only graph projection: it never starts a process, preview, check, or model turn. */
export function focusedWorkspace(task: Task, files: TaskFile[], session?: SessionView): FocusedWorkspace {
  const lifecycle: FocusedLifecycle = task.schedule?.uncertain ? 'interrupted' : task.schedule?.state === 'blocked' ? 'blocked' : task.schedule?.state === 'queued' || task.schedule?.state === 'enrolled' ? 'queued' : task.state === 'running' ? 'running' : task.state === 'error' ? 'blocked' : task.state === 'interrupted' ? 'interrupted' : task.reviewedCommit ? 'completed' : 'unavailable';
  const verification: FocusedVerification = { state: 'missing', attempts: [], required: 0, passed: 0, blockers: 0 }, effective = session?.turns.at(-1)?.modelSettings?.effective;
  return { taskId: task.id, lifecycle: verification.blockers ? 'validating' : lifecycle, worktree: task.worktree, branch: task.branch, session: task.interface === 'official-extension' ? 'external' : session?.active ? 'active' : task.interface === 'managed-cli' ? 'available' : 'unavailable', preview: 'unavailable', settings: effective ? `${effective.model} · ${effective.effort || 'provider default'}` : 'Not acknowledged', changes: structuredClone(files), verification };
}
