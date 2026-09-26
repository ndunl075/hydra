import type { HeadCheckView, HelperJobView, LaneView, Provider } from './model';
// Type-only, same rule as plans.ts above: jobs.ts pulls in node:fs/node:crypto for
// the job store, so only its types (never gateChip/gateState as values) may cross.
import type { JobCheckResult } from './jobs';
// Type-only: this file is bundled into the browser webview, and plans.ts's
// storage (PlanStore) pulls in node:fs/node:crypto, which a browser bundle
// cannot resolve. So only types cross this boundary; the tiny bit of cycle
// logic the canvas needs is duplicated below rather than imported as a value.
import type { Plan, PlanJob, PlanJobRunAs } from './plans';
// Type-only, same rule as above: planRunner.ts's PlanJobView/PlanJobStatus are
// plain data the extension computes; nothing here imports its runtime code.
import type { PlanJobView } from './planRunner';

/**
 * What the Agents canvas shows (docs/Agents_View_Plan.md). Pure, so the rules
 * are testable: which chats (leads) and heads are on the canvas, where each one
 * sits, and which finished heads have moved to the tray.
 *
 * - A head is on the canvas while it works, and for a short while after it
 *   finishes so you see the result. A head the lead has merged leaves at once.
 * - A finished head that isn't merged moves to the tray after that while.
 * - A lead is on the canvas while any of its heads is.
 */
export const finishedLingerMs = 2 * 60_000;
export const trayWindowMs = 12 * 3600_000;
/** How long an exited lane with no running heads sits quietly before it parks (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up"). */
export const laneParkMs = 10 * 60_000;
export const activeStates: ReadonlySet<string> = new Set(['queued', 'starting', 'running', 'blocked', 'checking']);

/**
 * A lead node. Most are a chat with heads; `kind: 'lane'` is an open lane
 * (docs/Lanes_And_Planner_Plan.md, section 2), shown even with no heads yet,
 * with its own status line instead of a head count.
 */
export interface CanvasLead { key: string; kind: 'chat' | 'lane'; provider?: Provider; label: string; status?: string; laneId?: string; startedAt: string; heads: string[]; x: number; y: number }
export interface CanvasHead { id: string; lead: string; depth: number; x: number; y: number; head: HelperJobView }
/** `plan-lane-head`: a head a plan lane started with hydra_start_head, joined from its lane's job slot (docs/Plan_Lanes_Plan.md, section 4). It isn't a plan job. */
export interface CanvasEdge { id: string; kind: 'lead' | 'dependency' | 'plan-lead' | 'plan-dependency' | 'plan-lane-head' | 'conflict'; from: string; to: string; waiting: boolean; active: boolean; cycle?: boolean }
/**
 * A plan that hasn't started running yet (docs/Lanes_And_Planner_Plan.md,
 * "Drafting on the canvas"): the plan itself renders as a lead node
 * ("Plan · title"), and its jobs as dashed draft nodes. Once a plan runs, its
 * jobs become real heads whose lead.sessionId is `plan-<id>`, so they group
 * under an ordinary CanvasLead through the usual grouping below; there is no
 * separate CanvasPlanNode for a running or done plan.
 */
/**
 * One job's slot in a plan group (docs/Plan_Lanes_Plan.md, section 4). For a
 * plan still being drafted, `view` is undefined and the slot is always the
 * dashed draft node. Once the plan has run, `view` carries its status and:
 * - `head` is set while its head is still drawn on the canvas (the ordinary head card);
 * - `lane` is set while its lane is open (the lane card);
 * - otherwise the slot is a small dashed status node reading `view.status`/`view.reason`.
 */
export interface CanvasPlanJob { id: string; planId: string; x: number; y: number; job: PlanJob; view?: PlanJobView; head?: HelperJobView; lane?: LaneView }
/** cycleMessage is set (and its edges flagged) when the plan's jobs have a dependency cycle; see planCycle below. */
export interface CanvasPlanNode { plan: Plan; x: number; y: number; jobs: CanvasPlanJob[]; cycleMessage?: string; progress?: string }
/** A parked lane's chip (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up"): exited, quiet for a while, no running heads. */
export interface CanvasParkedLane { id: string; name: string; conflicts: boolean; exitedAt: string }
export interface CanvasModel { leads: CanvasLead[]; heads: CanvasHead[]; edges: CanvasEdge[]; tray: HelperJobView[]; plans: CanvasPlanNode[]; parkedLanes: CanvasParkedLane[]; width: number; height: number }

export const layout = { leadX: 40, leadWidth: 190, headX: 330, columnGap: 290, headWidth: 250, rowGap: 172, groupGap: 56, top: 40 };

const finishedAt = (head: HelperJobView): number => Date.parse(head.finishedAt || head.createdAt);
export const isActive = (head: HelperJobView): boolean => activeStates.has(head.state);
const providerName = (provider?: Provider) => provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Agent';
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Whether a head is drawn on the canvas right now. */
export function onCanvas(head: HelperJobView, now: number): boolean {
  if (isActive(head)) return true;
  if (head.merged) return false;
  return now - finishedAt(head) < finishedLingerMs;
}

/**
 * The lead a head belongs to. A head started from a lane groups under that lane
 * node instead of its chat (docs/Lanes_And_Planner_Plan.md, section 2); heads
 * started before chats were tracked share one "this window" lead.
 */
export const leadKeyOf = (head: HelperJobView): string => head.lead?.lane || head.lead?.sessionId || 'window';

/**
 * The first dependency cycle in a plan's jobs, as a path like `['a','b','a']`
 * (duplicated from plans.ts's findCycle/cycleMessage: see the note above on
 * why this file cannot import that module's runtime code).
 */
function planCycle(jobs: readonly PlanJob[]): string[] | undefined {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    state.set(key, 1); stack.push(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) {
      if (!byKey.has(dependency)) continue;
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) { const found = visit(dependency); if (found) return found; }
    }
    stack.pop(); state.set(key, 2);
    return undefined;
  };
  for (const job of jobs) if (!state.has(job.key)) { const found = visit(job.key); if (found) return found; }
  return undefined;
}
function planCycleMessage(jobs: readonly PlanJob[], cycle: readonly string[]): string {
  const titleOf = new Map(jobs.map(job => [job.key, job.title || job.key]));
  return `The plan has a dependency cycle: ${cycle.map(key => titleOf.get(key) || key).join(' → ')}`;
}

/** A job's runAs, duplicated from plans.ts's jobRunAs (see the note atop this file on why plans.ts's runtime code never crosses here). */
const planJobRunAs = (job: Pick<PlanJob, 'runAs'>): PlanJobRunAs => job.runAs ?? 'head';

export function buildCanvas(all: readonly HelperJobView[], now: number, extras: { plans?: readonly Plan[]; lanes?: readonly LaneView[]; dismissedTray?: ReadonlySet<string>; planJobs?: Readonly<Record<string, readonly PlanJobView[]>> } = {}): CanvasModel {
  // ---- Plans that run (running, incomplete or recently done): their jobs get their own group, ----
  // ---- below, instead of grouping under an ordinary chat/lane lead. A done plan lingers while  ----
  // ---- any of its heads is still on canvas or any of its lanes is open, then leaves like a chat.
  const livePlans = (extras.plans || []).filter(plan => plan.state === 'running' || plan.state === 'incomplete' || plan.state === 'done');
  const planJobHeadIds = new Set<string>();
  const planLaneIds = new Set<string>();
  for (const plan of livePlans) for (const job of plan.jobs) {
    if (planJobRunAs(job) === 'head' && job.jobId) planJobHeadIds.add(job.jobId);
    if (planJobRunAs(job) === 'lane' && job.laneId) planLaneIds.add(job.laneId);
  }
  const shownPlans = livePlans.filter(plan => {
    if (plan.state !== 'done') return true;
    if (plan.jobs.some(job => planJobRunAs(job) === 'head' && job.jobId && all.some(head => head.id === job.jobId && onCanvas(head, now)))) return true;
    return plan.jobs.some(job => planJobRunAs(job) === 'lane' && job.laneId && (extras.lanes || []).some(item => item.id === job.laneId && (item.state === 'running' || item.state === 'exited')));
  });
  // Heads a plan lane started with hydra_start_head (docs/Plan_Lanes_Plan.md, section 4): not a job
  // themselves, they sit after their lane's job slot instead of grouping under it as a chat/lane lead.
  const subHeadsByLane = new Map<string, HelperJobView[]>();
  for (const head of all) {
    if (!head.lead?.lane || !planLaneIds.has(head.lead.lane)) continue;
    subHeadsByLane.set(head.lead.lane, [...(subHeadsByLane.get(head.lead.lane) || []), head]);
  }
  const subHeadIds = new Set([...subHeadsByLane.values()].flat().map(head => head.id));

  const visible = all.filter(head => onCanvas(head, now) && !planJobHeadIds.has(head.id) && !subHeadIds.has(head.id));
  const tray = all.filter(head => !onCanvas(head, now) && !head.merged && !isActive(head) && now - finishedAt(head) < trayWindowMs && !extras.dismissedTray?.has(head.id))
    .sort((a, b) => finishedAt(b) - finishedAt(a));
  // Group by chat, oldest chat first; within a chat, oldest head first.
  const groups = new Map<string, HelperJobView[]>();
  for (const head of [...visible].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = leadKeyOf(head);
    groups.set(key, [...(groups.get(key) || []), head]);
  }
  const leads: CanvasLead[] = [], heads: CanvasHead[] = [], edges: CanvasEdge[] = [];
  let top = layout.top, widest = layout.headX + layout.headWidth;
  for (const [key, members] of groups) {
    // Depth: how many heads (in this chat) a head waits on, transitively. Dependents sit to the right.
    const byId = new Map(members.map(head => [head.id, head]));
    const depthOf = new Map<string, number>();
    const depth = (head: HelperJobView, seen = new Set<string>()): number => {
      if (depthOf.has(head.id)) return depthOf.get(head.id)!;
      if (seen.has(head.id)) return 0;
      seen.add(head.id);
      const parents = head.dependsOn.map(id => byId.get(id)).filter((item): item is HelperJobView => !!item);
      const value = parents.length ? 1 + Math.max(...parents.map(parent => depth(parent, seen))) : 0;
      depthOf.set(head.id, value);
      return value;
    };
    const columns = new Map<number, HelperJobView[]>();
    for (const head of members) columns.set(depth(head), [...(columns.get(depth(head)) || []), head]);
    const rows = Math.max(...[...columns.values()].map(column => column.length));
    const groupHeight = rows * layout.rowGap;
    for (const [column, list] of columns) {
      // Centre shorter columns against the tallest one.
      const offset = ((rows - list.length) * layout.rowGap) / 2;
      list.forEach((head, row) => {
        const x = layout.headX + column * layout.columnGap, y = top + offset + row * layout.rowGap;
        heads.push({ id: head.id, lead: key, depth: column, x, y, head });
        widest = Math.max(widest, x + layout.headWidth);
      });
    }
    const first = members[0]!;
    const provider = members.find(head => head.lead?.provider)?.lead?.provider;
    const label = members.find(head => head.lead?.label)?.lead?.label
      || (key === 'window' ? 'This window' : `${providerName(provider)} chat · ${timeOf(first.createdAt)}`);
    // A lane's heads are patched into "lane" leads just below; here they still get an ordinary chat lead
    // (overwritten there) so a lane's own label and provider always win over a head's lead.label/provider.
    leads.push({ key, kind: 'chat', provider, label, startedAt: first.createdAt, heads: members.map(head => head.id), x: layout.leadX, y: top + groupHeight / 2 - layout.rowGap / 2 });
    for (const head of members) {
      const roots = head.dependsOn.filter(id => byId.has(id));
      if (!roots.length) edges.push({ id: `${key}>${head.id}`, kind: 'lead', from: key, to: head.id, waiting: false, active: isActive(head) });
      for (const dependency of roots) {
        const parent = byId.get(dependency)!;
        edges.push({ id: `${dependency}>${head.id}`, kind: 'dependency', from: dependency, to: head.id, waiting: head.state === 'queued' && isActive(parent), active: isActive(head) });
      }
    }
    top += groupHeight + layout.groupGap;
  }

  // ---- Lanes (docs/Lanes_And_Planner_Plan.md, section 2). Every open lane (running or ----
  // ---- exited, not closed or merged) is a lead node, even with no heads. Heads with   ----
  // ---- lead.lane === lane.id already grouped above (leadKeyOf prefers the lane id), so ----
  // ---- their chat lead is patched into a lane node here; a lane with no heads gets one ----
  // ---- of its own. A red dashed conflict edge joins each conflicting pair, once.       ----
  // A parked lane (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up"): exited for at least
  // laneParkMs, with no running heads. Running lanes, and lanes with running heads, always
  // stay full nodes even past that window. A lane that exited before exitedAt was recorded
  // has no time: it exited long ago, so it parks.
  const hasRunningHeads = (laneId: string): boolean => all.some(head => leadKeyOf(head) === laneId && isActive(head));
  const isParked = (lane: LaneView): boolean =>
    lane.state === 'exited' && (!lane.exitedAt || now - Date.parse(lane.exitedAt) >= laneParkMs) && !hasRunningHeads(lane.id);
  const parkedLanes: CanvasParkedLane[] = (extras.lanes || []).filter(lane => isParked(lane) && !planLaneIds.has(lane.id))
    .map(lane => ({ id: lane.id, name: lane.name, conflicts: !!lane.sync?.conflicts.length, exitedAt: lane.exitedAt ?? '' }));
  // A plan lane isn't drawn twice (docs/Plan_Lanes_Plan.md, section 4): its own lane card sits in its job's slot below.
  const openLanes = (extras.lanes || []).filter(lane => (lane.state === 'running' || lane.state === 'exited') && !isParked(lane) && !planLaneIds.has(lane.id));
  const laneById = new Map(openLanes.map(lane => [lane.id, lane]));
  const laneStatus = (lane: LaneView): string => {
    if (lane.state === 'exited') return 'Exited';
    const conflict = lane.sync?.conflicts[0];
    if (conflict) return `Conflicts with ${laneById.get(conflict.laneId)?.name || 'another lane'}`;
    return `Working · ${lane.branch}`;
  };
  for (const lane of openLanes) {
    const existing = leads.find(item => item.key === lane.id);
    if (existing) { existing.kind = 'lane'; existing.laneId = lane.id; existing.provider = lane.provider; existing.label = lane.name; existing.status = laneStatus(lane); continue; }
    leads.push({ key: lane.id, kind: 'lane', laneId: lane.id, provider: lane.provider, label: lane.name, status: laneStatus(lane), startedAt: lane.createdAt, heads: [], x: layout.leadX, y: top });
    top += layout.rowGap + layout.groupGap;
  }
  const conflictPairs = new Set<string>();
  for (const lane of openLanes) {
    for (const conflict of lane.sync?.conflicts || []) {
      if (!laneById.has(conflict.laneId)) continue;
      const pair = [lane.id, conflict.laneId].sort().join('|');
      if (conflictPairs.has(pair)) continue;
      conflictPairs.add(pair);
      edges.push({ id: `conflict:${pair}`, kind: 'conflict', from: lane.id, to: conflict.laneId, waiting: false, active: false });
    }
  }

  // ---- Plans still being drafted (docs/Lanes_And_Planner_Plan.md, section 4): planning, draft or ----
  // ---- failed. A running, incomplete or done plan gets its own group below instead (section 4 of ----
  // ---- docs/Plan_Lanes_Plan.md), with heads and lanes drawn as job slots rather than a chat lead. ----
  const plans: CanvasPlanNode[] = [];
  for (const plan of (extras.plans || []).filter(plan => plan.state !== 'running' && plan.state !== 'done' && plan.state !== 'incomplete')) {
    const jobById = new Map(plan.jobs.map(job => [job.key, job]));
    const planJobId = (key: string) => `${plan.id}:${key}`;
    const depthOf = new Map<string, number>();
    const depth = (job: PlanJob, seen = new Set<string>()): number => {
      if (depthOf.has(job.key)) return depthOf.get(job.key)!;
      if (seen.has(job.key)) return 0; // part of a cycle; column 0 avoids infinite recursion
      seen.add(job.key);
      const parents = job.dependsOn.map(key => jobById.get(key)).filter((item): item is PlanJob => !!item);
      const value = parents.length ? 1 + Math.max(...parents.map(parent => depth(parent, seen))) : 0;
      depthOf.set(job.key, value);
      return value;
    };
    // In a cycle every job has a parent, so no job sits at depth 0: start at the shallowest.
    const shallowest = plan.jobs.length ? Math.min(...plan.jobs.map(job => depth(job))) : 0;
    const columns = new Map<number, PlanJob[]>();
    for (const job of plan.jobs) { const column = depth(job) - shallowest; columns.set(column, [...(columns.get(column) || []), job]); }
    const rows = Math.max(1, ...[...columns.values()].map(column => column.length));
    const groupHeight = rows * layout.rowGap;
    const jobs: CanvasPlanJob[] = [];
    for (const [column, list] of columns) {
      const offset = ((rows - list.length) * layout.rowGap) / 2;
      list.forEach((job, row) => {
        const x = layout.headX + column * layout.columnGap, y = top + offset + row * layout.rowGap;
        jobs.push({ id: planJobId(job.key), planId: plan.id, x, y, job });
        widest = Math.max(widest, x + layout.headWidth);
      });
    }
    const cycle = planCycle(plan.jobs);
    plans.push({ plan, x: layout.leadX, y: top + groupHeight / 2 - layout.rowGap / 2, jobs, ...(cycle ? { cycleMessage: planCycleMessage(plan.jobs, cycle) } : {}) });
    const cycleEdges = new Set<string>();
    if (cycle) for (let index = 0; index < cycle.length - 1; index++) cycleEdges.add(`${cycle[index]}>${cycle[index + 1]}`);
    for (const job of plan.jobs) {
      const roots = job.dependsOn.filter(key => jobById.has(key));
      if (!roots.length) edges.push({ id: `plan-lead:${plan.id}>${planJobId(job.key)}`, kind: 'plan-lead', from: plan.id, to: planJobId(job.key), waiting: false, active: false });
      for (const dependency of roots) {
        edges.push({ id: `${planJobId(dependency)}>${planJobId(job.key)}`, kind: 'plan-dependency', from: planJobId(dependency), to: planJobId(job.key), waiting: false, active: false, cycle: cycleEdges.has(`${dependency}>${job.key}`) });
      }
    }
    top += Math.max(groupHeight, layout.rowGap) + layout.groupGap;
  }

  // ---- Running plans (docs/Plan_Lanes_Plan.md, section 4). A plan stays grouped while it runs, is ----
  // ---- incomplete, or is done (shownPlanIds above): the plan node, with each job's slot a head    ----
  // ---- card, a lane card or a small dashed status node, plus dependency edges between them.       ----
  const byPlanId = new Map((extras.planJobs && Object.entries(extras.planJobs)) || []);
  for (const plan of shownPlans) {
    const jobById = new Map(plan.jobs.map(job => [job.key, job]));
    const viewByKey = new Map((byPlanId.get(plan.id) || []).map(view => [view.key, view]));
    const planJobId = (key: string) => `${plan.id}:${key}`;
    const depthOf = new Map<string, number>();
    const depth = (job: PlanJob, seen = new Set<string>()): number => {
      if (depthOf.has(job.key)) return depthOf.get(job.key)!;
      if (seen.has(job.key)) return 0;
      seen.add(job.key);
      const parents = job.dependsOn.map(key => jobById.get(key)).filter((item): item is PlanJob => !!item);
      const value = parents.length ? 1 + Math.max(...parents.map(parent => depth(parent, seen))) : 0;
      depthOf.set(job.key, value);
      return value;
    };
    const shallowest = plan.jobs.length ? Math.min(...plan.jobs.map(job => depth(job))) : 0;
    const columns = new Map<number, PlanJob[]>();
    for (const job of plan.jobs) { const column = depth(job) - shallowest; columns.set(column, [...(columns.get(column) || []), job]); }
    // One extra column for any lane job's sub-heads (hydra_start_head from inside the lane), so they never overlap a real job column.
    const maxColumn = Math.max(0, ...[...columns.keys()]);
    const rows = Math.max(1, ...[...columns.values()].map(column => column.length));
    const groupHeight = rows * layout.rowGap;
    const jobs: CanvasPlanJob[] = [];
    const columnOf = new Map<string, number>();
    for (const [column, list] of columns) {
      const offset = ((rows - list.length) * layout.rowGap) / 2;
      list.forEach((job, row) => {
        const x = layout.headX + column * layout.columnGap, y = top + offset + row * layout.rowGap;
        columnOf.set(job.key, column);
        const view = viewByKey.get(job.key);
        const runAs = planJobRunAs(job);
        const activeHead = runAs === 'head' && job.jobId ? all.find(head => head.id === job.jobId && onCanvas(head, now)) : undefined;
        const openLane = runAs === 'lane' && job.laneId ? (extras.lanes || []).find(item => item.id === job.laneId && (item.state === 'running' || item.state === 'exited')) : undefined;
        jobs.push({ id: planJobId(job.key), planId: plan.id, x, y, job, view, ...(activeHead ? { head: activeHead } : {}), ...(openLane ? { lane: openLane } : {}) });
        widest = Math.max(widest, x + layout.headWidth);
      });
    }
    plans.push({ plan, x: layout.leadX, y: top + groupHeight / 2 - layout.rowGap / 2, jobs, progress: planProgress(plan, [...viewByKey.values()]) });
    for (const job of plan.jobs) {
      const roots = job.dependsOn.filter(key => jobById.has(key));
      if (!roots.length) edges.push({ id: `plan-lead:${plan.id}>${planJobId(job.key)}`, kind: 'plan-lead', from: plan.id, to: planJobId(job.key), waiting: false, active: false });
      const view = viewByKey.get(job.key);
      for (const dependency of roots) {
        const dependencyView = viewByKey.get(dependency);
        const waiting = view?.status === 'waiting' && dependencyView?.status === 'active';
        const active = view?.status === 'active';
        edges.push({ id: `${planJobId(dependency)}>${planJobId(job.key)}`, kind: 'plan-dependency', from: planJobId(dependency), to: planJobId(job.key), waiting: !!waiting, active: !!active });
      }
    }
    // Heads a plan lane started (docs/Plan_Lanes_Plan.md, section 4): sit in the column after the lane's job slot.
    for (const job of plan.jobs) {
      if (!job.laneId) continue;
      const subHeads = subHeadsByLane.get(job.laneId);
      if (!subHeads?.length) continue;
      const column = (columnOf.get(job.key) ?? maxColumn) + 1;
      const slot = jobs.find(item => item.job.key === job.key)!;
      subHeads.forEach((head, row) => {
        const x = layout.headX + column * layout.columnGap, y = slot.y + row * layout.rowGap;
        heads.push({ id: head.id, lead: slot.id, depth: column, x, y, head });
        widest = Math.max(widest, x + layout.headWidth);
        edges.push({ id: `${slot.id}>${head.id}`, kind: 'plan-lane-head', from: slot.id, to: head.id, waiting: false, active: isActive(head) });
      });
    }
    top += Math.max(groupHeight, layout.rowGap) + layout.groupGap;
  }

  return { leads, heads, edges, tray, plans, parkedLanes, width: widest + 60, height: Math.max(top - layout.groupGap + layout.top, 240) };
}

/** The plan node's status line while it runs, is incomplete, or is done (docs/Plan_Lanes_Plan.md, section 4). */
function planProgress(plan: Plan, views: readonly PlanJobView[]): string {
  const done = views.filter(view => view.status === 'done').length;
  const total = plan.jobs.length;
  if (plan.state === 'incomplete') {
    const failed = views.filter(view => view.status === 'failed').length;
    const cancelled = views.filter(view => view.status === 'cancelled').length;
    const skipped = views.filter(view => view.status === 'skipped').length;
    const bits = [failed && `${failed} failed`, cancelled && `${cancelled} cancelled`, skipped && `${skipped} skipped`].filter(Boolean);
    return `Incomplete · ${bits.join(', ') || 'nothing left to wait for'}`;
  }
  if (plan.state === 'done') return `${done} of ${total} done`;
  const activeLane = views.find(view => view.status === 'active' && view.laneId);
  return `${done} of ${total} done${activeLane ? ` · waiting for you in ${plan.jobs.find(job => job.key === activeLane.key)?.title || activeLane.key}` : ''}`;
}

/**
 * A gate chip (docs/Gates_Plan.md, "Seeing results"): "✓ unit · ✓ review · ✗
 * ui", plus a not-run style with the reason on hover. Text as well as colour,
 * never colour alone. The same reading src/core/jobs.ts's gateChip gives
 * server-side, duplicated here (never imported as a value — see the note atop
 * this file) so the webview bundle never needs jobs.ts's Node-only imports.
 */
export interface GateChipView { id: string; icon: '✓' | '✗' | '–'; label: string; tone: 'good' | 'bad' | 'neutral'; title: string }
export function gateChip(check: Pick<HeadCheckView, 'id' | 'summary'> & { state?: JobCheckResult['state']; passed: boolean; pack?: string; packTitle?: string }): GateChipView {
  const state = check.state ?? (check.passed ? 'passed' : 'failed');
  const icon = state === 'passed' ? '✓' : state === 'notRun' ? '–' : '✗';
  const tone: GateChipView['tone'] = state === 'passed' ? 'good' : state === 'notRun' ? 'neutral' : 'bad';
  const base = state === 'notRun' ? (check.summary ? `Not run: ${check.summary}` : 'Not run') : (check.summary || (state === 'failed' ? 'Failed' : 'Passed'));
  // Packs (docs/Packs_Plan.md, "How roles show"): a pack gate's tooltip adds "From the Coding pack".
  const title = check.pack ? `${base} · From the ${check.packTitle || check.pack} pack` : base;
  return { id: check.id, icon, label: `${icon} ${check.id}`, tone, title };
}

/** A short, human state for a head. */
export const headStatus: Record<string, string> = {
  queued: 'Queued', starting: 'Starting', running: 'Working', blocked: 'Needs an answer', checking: 'Checking',
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

/** Seconds since a head started (or was created), for the elapsed clock. */
export function elapsedLabel(head: HelperJobView, now: number): string {
  const start = Date.parse(head.startedAt || head.createdAt);
  const end = isActive(head) ? now : Date.parse(head.finishedAt || new Date(now).toISOString());
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
