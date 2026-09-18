import type { SessionView, Task, Turn } from './model';

export interface UsageTotals {
  input: number; output: number; cacheRead?: number; cacheCreated?: number; estimatedUsd?: number;
}
export interface UsageSummary {
  claude?: UsageTotals;
  codex?: UsageTotals;
  recordedTurns: number;
  unmeasuredTurns: number;
  tasksWithoutHistory: number;
}
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validThreadUsage(value: unknown): value is NonNullable<Turn['threadUsage']> {
  if (!value || typeof value !== 'object') return false;
  const usage = value as NonNullable<Turn['threadUsage']>;
  return typeof usage.sessionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(usage.sessionId)
    && numeric(usage.input) && numeric(usage.output) && ['cacheRead', 'cacheCreated'].every(key => {
      const n = usage[key as 'cacheRead' | 'cacheCreated']; return n === undefined || numeric(n);
    });
}
function add(left: UsageTotals | undefined, right: UsageTotals): UsageTotals {
  if (!left) return { ...right };
  return {
    input: left.input + right.input, output: left.output + right.output,
    // A missing cache or money measurement is unknown, never an invented zero.
    cacheRead: left.cacheRead === undefined || right.cacheRead === undefined ? undefined : left.cacheRead + right.cacheRead,
    cacheCreated: left.cacheCreated === undefined || right.cacheCreated === undefined ? undefined : left.cacheCreated + right.cacheCreated,
    estimatedUsd: left.estimatedUsd === undefined || right.estimatedUsd === undefined ? undefined : left.estimatedUsd + right.estimatedUsd
  };
}

/** Recompute from complete persisted histories. Replayed cumulative events never become deltas. */
export function summarizeUsage(entries: { taskId: string; session?: SessionView }[]): UsageSummary {
  const result: UsageSummary = { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 0 };
  const seen = new Set<string>(), threads = new Map<string, { at: string; usage: NonNullable<Turn['threadUsage']> }>();
  for (const { taskId, session } of entries) {
    if (!session?.turns.length) result.tasksWithoutHistory++;
    for (const turn of session?.turns || []) {
      const key = `${taskId}:${turn.id}`;
      if (seen.has(key)) continue;
      seen.add(key); result.recordedTurns++;
      if (turn.provider === 'claude' && turn.usage && turn.usageSource === 'claude-result') result.claude = add(result.claude, turn.usage);
      else if (turn.provider === 'codex' && turn.threadUsage) {
        // The latest durable observation replaces the old one, including after a provider reset.
        const previous = threads.get(turn.threadUsage.sessionId);
        if (!previous || turn.createdAt >= previous.at) threads.set(turn.threadUsage.sessionId, { at: turn.createdAt, usage: turn.threadUsage });
      } else result.unmeasuredTurns++;
    }
  }
  for (const { usage } of threads.values()) result.codex = add(result.codex, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreated: usage.cacheCreated });
  return result;
}
export function usageSnapshot(tasks: Task[], view: (id: string) => SessionView | undefined): { tasks: Record<string, UsageSummary>; projects: Record<string, UsageSummary> } {
  const perTask: Record<string, UsageSummary> = {}, projects: Record<string, UsageSummary> = {};
  const entries = tasks.map(task => ({ taskId: task.id, repository: task.repository, session: view(task.id) }));
  for (const entry of entries) perTask[entry.taskId] = summarizeUsage([entry]);
  for (const repository of new Set(tasks.map(task => task.repository))) projects[repository] = summarizeUsage(entries.filter(entry => entry.repository === repository));
  return { tasks: perTask, projects };
}
/** Direct durable children only; unavailable histories remain visible in the summary. */
export function delegationRunUsage(parentId: string, tasks: Task[], view: (id: string) => SessionView | undefined): UsageSummary {
  if (!tasks.some(task => task.id === parentId)) throw new Error('Unknown delegation parent task.');
  return summarizeUsage(tasks.filter(task => task.id === parentId || task.delegation?.parentId === parentId).map(task => ({ taskId: task.id, session: view(task.id) })));
}
