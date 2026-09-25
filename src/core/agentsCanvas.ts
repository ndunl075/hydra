import type { HelperJobView, Provider } from './model';
// Type-only: this file is bundled into the browser webview, and plans.ts's
// storage (PlanStore) pulls in node:fs/node:crypto, which a browser bundle
// cannot resolve. So only types cross this boundary; the tiny bit of cycle
// logic the canvas needs is duplicated below rather than imported as a value.
import type { Plan, PlanJob } from './plans';

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
export const activeStates: ReadonlySet<string> = new Set(['queued', 'starting', 'running', 'blocked', 'checking']);

export interface CanvasLead { key: string; provider?: Provider; label: string; startedAt: string; heads: string[]; x: number; y: number }
export interface CanvasHead { id: string; lead: string; depth: number; x: number; y: number; head: HelperJobView }
export interface CanvasEdge { id: string; kind: 'lead' | 'dependency' | 'plan-lead' | 'plan-dependency'; from: string; to: string; waiting: boolean; active: boolean; cycle?: boolean }
/**
 * A plan that hasn't started running yet (docs/Lanes_And_Planner_Plan.md,
 * "Drafting on the canvas"): the plan itself renders as a lead node
 * ("Plan · title"), and its jobs as dashed draft nodes. Once a plan runs, its
 * jobs become real heads whose lead.sessionId is `plan-<id>`, so they group
 * under an ordinary CanvasLead through the usual grouping below; there is no
 * separate CanvasPlanNode for a running or done plan.
 */
export interface CanvasPlanJob { id: string; planId: string; x: number; y: number; job: PlanJob }
/** cycleMessage is set (and its edges flagged) when the plan's jobs have a dependency cycle; see planCycle below. */
export interface CanvasPlanNode { plan: Plan; x: number; y: number; jobs: CanvasPlanJob[]; cycleMessage?: string }
export interface CanvasModel { leads: CanvasLead[]; heads: CanvasHead[]; edges: CanvasEdge[]; tray: HelperJobView[]; plans: CanvasPlanNode[]; width: number; height: number }

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

/** The chat a head belongs to. Heads started before chats were tracked share one "this window" lead. */
export const leadKeyOf = (head: HelperJobView): string => head.lead?.sessionId || 'window';

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

export function buildCanvas(all: readonly HelperJobView[], now: number, extras: { plans?: readonly Plan[] } = {}): CanvasModel {
  const visible = all.filter(head => onCanvas(head, now));
  const tray = all.filter(head => !onCanvas(head, now) && !head.merged && !isActive(head) && now - finishedAt(head) < trayWindowMs)
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
    leads.push({ key, provider, label, startedAt: first.createdAt, heads: members.map(head => head.id), x: layout.leadX, y: top + groupHeight / 2 - layout.rowGap / 2 });
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

  // ---- Plans (docs/Lanes_And_Planner_Plan.md, section 4). A running or done plan's ----
  // ---- heads already grouped above, by their lead.sessionId of `plan-<id>`. Only a  ----
  // ---- plan still being drafted (planning, draft or failed) gets its own node here. ----
  const plans: CanvasPlanNode[] = [];
  for (const plan of (extras.plans || []).filter(plan => plan.state !== 'running' && plan.state !== 'done')) {
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

  return { leads, heads, edges, tray, plans, width: widest + 60, height: Math.max(top - layout.groupGap + layout.top, 240) };
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
