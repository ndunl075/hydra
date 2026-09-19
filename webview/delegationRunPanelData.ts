import type { Snapshot, Task } from '../src/core/model';
import { budgetMessage } from '../src/core/budgets';
import type { ChildRunUsage, RunSoftHold } from './DelegationRunBudgetView';
import type { UsageSummary } from '../src/core/usage';

const unavailable = (): UsageSummary => ({ recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 });

/** Display only. The run total remains the separately deduplicated host projection. */
export function selectedRunPanelData(snapshot: Snapshot, child: Task): { children: ChildRunUsage[]; holds: RunSoftHold[] } {
  const link = child.delegation;
  if (!link) return { children: [], holds: [] };
  const tasks = snapshot.tasks.filter(task => task.delegation?.parentId === link.parentId && task.delegation.runId === link.runId);
  const children = tasks.map(task => {
    const usage = snapshot.usage?.tasks[task.id] || unavailable();
    return { childKey: task.delegation!.childKey, usage, coverage: !usage.recordedTurns ? 'unavailable' as const : usage.unmeasuredTurns || usage.tasksWithoutHistory ? 'partial' as const : 'available' as const };
  });
  const holds = tasks.flatMap(task => {
    const observed = (snapshot.budgets?.observations[task.id] || []).filter(item => item.action === 'hold' && item.reached && item.provider === task.provider).map(item => ({ provider: item.provider, reason: budgetMessage(item) }));
    const queued = task.schedule?.budgetHold && task.schedule.reason ? [{ provider: task.provider, reason: task.schedule.reason }] : [];
    return [...observed, ...queued];
  });
  const uniqueHolds = [...new Map(holds.map(item => [`${item.provider}:${item.reason}`, item])).values()];
  return { children, holds: uniqueHolds };
}
