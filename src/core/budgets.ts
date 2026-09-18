import type { Provider, Task } from './model';
import type { UsageSummary } from './usage';

export interface SoftBudget {
  provider: Provider;
  action: 'warn' | 'hold';
  inputOutputTokens?: number;
  estimatedUsd?: number;
}
export interface BudgetSettings { tasks: Record<string, SoftBudget[]>; projects: Record<string, SoftBudget[]> }
export interface BudgetObservation {
  scope: 'task' | 'project'; provider: Provider; action: 'warn' | 'hold';
  metric: 'inputOutputTokens' | 'estimatedUsd'; limit: number; observed?: number; partial: boolean; reached: boolean;
}
export const emptyBudgets = (): BudgetSettings => ({ tasks: {}, projects: {} });
export function parseBudgets(value: unknown): SoftBudget[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error('Invalid soft budgets. Original data has been retained.');
  const providers = new Set<Provider>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['provider', 'action', 'inputOutputTokens', 'estimatedUsd'].includes(key)) ||
      !['claude', 'codex'].includes(item.provider) || !['warn', 'hold'].includes(item.action) || providers.has(item.provider) ||
      (item.inputOutputTokens === undefined && item.estimatedUsd === undefined) ||
      (item.inputOutputTokens !== undefined && (!Number.isSafeInteger(item.inputOutputTokens) || item.inputOutputTokens <= 0)) ||
      (item.estimatedUsd !== undefined && (item.provider !== 'claude' || typeof item.estimatedUsd !== 'number' || !Number.isFinite(item.estimatedUsd) || item.estimatedUsd <= 0 || item.estimatedUsd > 1e9))) throw new Error('Invalid soft budgets. Enter positive limits; API estimates are available only for Claude.');
    providers.add(item.provider);
    return { provider: item.provider, action: item.action, ...(item.inputOutputTokens === undefined ? {} : { inputOutputTokens: item.inputOutputTokens }), ...(item.estimatedUsd === undefined ? {} : { estimatedUsd: item.estimatedUsd }) };
  });
}
/** Thresholds apply to locally recorded history, including retired tasks. Unknown usage is never zero. */
export function assessBudgets(task: Task, settings: BudgetSettings, usage: { tasks: Record<string, UsageSummary>; projects: Record<string, UsageSummary> }): BudgetObservation[] {
  const observations: BudgetObservation[] = [];
  for (const scope of ['task', 'project'] as const) {
    const summary = scope === 'task' ? usage.tasks[task.id] : usage.projects[task.repository];
    const budgets = scope === 'task' ? settings.tasks[task.id] : settings.projects[task.repository];
    for (const budget of budgets || []) {
      const totals = summary?.[budget.provider];
      for (const metric of ['inputOutputTokens', 'estimatedUsd'] as const) {
        const limit = budget[metric];
        if (limit === undefined) continue;
        const observed = metric === 'inputOutputTokens' ? totals ? totals.input + totals.output : undefined : totals?.estimatedUsd;
        observations.push({ scope, provider: budget.provider, action: budget.action, metric, limit, observed,
          partial: !summary || summary.unmeasuredTurns > 0 || summary.tasksWithoutHistory > 0 || task.interface !== 'managed-cli', reached: observed !== undefined && observed >= limit });
      }
    }
  }
  return observations;
}
export function budgetMessage(observation: BudgetObservation): string {
  const unit = observation.metric === 'estimatedUsd' ? 'USD API estimate' : 'reported input + output tokens';
  return `${observation.scope === 'task' ? 'Task' : 'Project'} ${observation.provider} budget reached: ${observation.observed} / ${observation.limit} ${unit}.`;
}
export class BudgetHoldError extends Error {
  constructor(readonly reasons: string[]) { super(`${reasons.join(' ')} New work held. Change the budget, then explicitly retry or cancel the queued launch.`); this.name = 'BudgetHoldError'; }
}
export function checkBudgetLaunch(provider: Provider, observations: BudgetObservation[]): string[] {
  const reached = observations.filter(item => item.provider === provider && item.reached);
  const holds = reached.filter(item => item.action === 'hold');
  if (holds.length) throw new BudgetHoldError(holds.map(budgetMessage));
  return reached.map(budgetMessage);
}


