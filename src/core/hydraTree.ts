import type { HelperJobView, LaneView, Provider, SnapshotRole } from './model';
import type { Plan } from './plans';
import { isActive } from './agentsCanvas';
// Type-only, same rule as agentsCanvas.ts: planRunner.ts's PlanJobView is plain data the extension computes.
import type { PlanJobView } from './planRunner';

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

/** A plan's job-progress line (docs/Plan_Lanes_Plan.md, section 5): "Running · 2 of 4 done · 1 lane waiting", or "Incomplete · 1 failed". */
function planProgressLine(plan: Plan, views: readonly PlanJobView[] | undefined): string {
  if (plan.state === 'planning') return 'Planning…';
  if (plan.state === 'failed') return 'Planning failed';
  const count = `${plan.jobs.length} ${plan.jobs.length === 1 ? 'job' : 'jobs'}`;
  if (plan.state === 'draft' || !views) return `Draft · ${count}`;
  const done = views.filter(view => view.status === 'done').length;
  if (plan.state === 'incomplete') {
    const bits = (['failed', 'cancelled', 'skipped'] as const)
      .map(state => { const found = views.filter(view => view.status === state).length; return found ? `${found} ${state}` : undefined; })
      .filter((text): text is string => !!text);
    return `Incomplete · ${bits.join(', ') || 'nothing left to wait for'}`;
  }
  const laneWaiting = views.filter(view => view.status === 'active' && view.laneId).length;
  const progress = `${done} of ${plan.jobs.length} done`;
  return plan.state === 'done' ? progress : `Running · ${progress}${laneWaiting ? ` · ${laneWaiting} ${laneWaiting === 1 ? 'lane' : 'lanes'} waiting` : ''}`;
}

export function buildHydraTree(lanes: readonly LaneView[], heads: readonly HelperJobView[], plans: readonly Plan[], planJobs: Readonly<Record<string, readonly PlanJobView[]>> = {}, roles: readonly SnapshotRole[] = []): HydraTree {
  const laneItems: TreeLaneItem[] = openLanes(lanes).map(lane => {
    const conflicts = !!lane.sync?.conflicts.length;
    // Packs (docs/Packs_Plan.md, "How roles show"): "Codex · Reviewer · lane/x".
    const roleTitle = lane.role ? roles.find(role => role.pack === lane.role!.pack && role.id === lane.role!.role)?.title : undefined;
    const description = [providerName(lane.provider), roleTitle, lane.branch, lane.planJob ? `Plan: ${lane.planJob.planTitle}` : undefined, conflicts ? 'conflicts' : undefined].filter(Boolean).join(' · ');
    return { id: lane.id, label: lane.name, description, state: lane.state, conflicts, dirty: !!lane.sync?.dirty };
  });
  const headItems: TreeHeadItem[] = heads.filter(isActive).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(head => ({
    id: head.id, label: head.title, description: `${headStatus[head.state] || head.state}${head.lead?.label ? ` · ${head.lead.label}` : ''}`, state: head.state,
  }));
  const planItems: TreePlanItem[] = livePlans(plans).map(plan => ({ id: plan.id, label: plan.title, description: planProgressLine(plan, planJobs[plan.id]), state: plan.state }));
  return { lanes: laneItems, heads: headItems, plans: planItems, empty: !laneItems.length && !headItems.length && !planItems.length };
}
