import type { HelperJobView, LaneView, Provider } from './model';
import type { Plan } from './plans';
import { isActive } from './agentsCanvas';

/**
 * The Hydra activity-bar panel (docs/Lanes_And_Planner_Plan.md, section 3): one
 * tree with three groups (Lanes, Heads, Plans). Pure, like agentsCanvas.ts, so
 * the grouping and labels are testable without a vscode.TreeDataProvider.
 */
export interface TreeLaneItem { id: string; label: string; description: string; state: LaneView['state']; conflicts: boolean; dirty: boolean }
export interface TreeHeadItem { id: string; label: string; description: string; state: string }
export interface TreePlanItem { id: string; label: string; description: string; state: Plan['state'] }
export interface HydraTree { lanes: TreeLaneItem[]; heads: TreeHeadItem[]; plans: TreePlanItem[]; empty: boolean }

const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude';
const headStatus: Record<string, string> = {
  queued: 'Queued', starting: 'Starting', running: 'Working', blocked: 'Needs an answer', checking: 'Checking',
};

/** Open lanes: not merged or closed, newest first. */
export function openLanes(lanes: readonly LaneView[]): LaneView[] {
  return lanes.filter(lane => lane.state === 'running' || lane.state === 'exited').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Drafts and running plans (a done plan has nothing left to show here). */
export function livePlans(plans: readonly Plan[]): Plan[] {
  return plans.filter(plan => plan.state !== 'done').slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function buildHydraTree(lanes: readonly LaneView[], heads: readonly HelperJobView[], plans: readonly Plan[]): HydraTree {
  const laneItems: TreeLaneItem[] = openLanes(lanes).map(lane => {
    const conflicts = !!lane.sync?.conflicts.length;
    const description = [providerName(lane.provider), lane.branch, conflicts ? 'conflicts' : undefined].filter(Boolean).join(' · ');
    return { id: lane.id, label: lane.name, description, state: lane.state, conflicts, dirty: !!lane.sync?.dirty };
  });
  const headItems: TreeHeadItem[] = heads.filter(isActive).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(head => ({
    id: head.id, label: head.title, description: `${headStatus[head.state] || head.state}${head.lead?.label ? ` · ${head.lead.label}` : ''}`, state: head.state,
  }));
  const planItems: TreePlanItem[] = livePlans(plans).map(plan => ({
    id: plan.id, label: plan.title, description: plan.state === 'running' ? `Running · ${plan.jobs.length} ${plan.jobs.length === 1 ? 'job' : 'jobs'}`
      : plan.state === 'planning' ? 'Planning…' : plan.state === 'failed' ? 'Planning failed' : `Draft · ${plan.jobs.length} ${plan.jobs.length === 1 ? 'job' : 'jobs'}`,
    state: plan.state,
  }));
  return { lanes: laneItems, heads: headItems, plans: planItems, empty: !laneItems.length && !headItems.length && !planItems.length };
}
