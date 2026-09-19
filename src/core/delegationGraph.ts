import type { Task } from './model';
import { parseDelegationGraphEvents, type DelegationGraphEvent } from './delegationGraphEvents';
export interface DelegationGraphEdge { from: string; to: string; kind: 'assignment' | 'dependency'; state: 'queued' | 'running' | 'blocked' | 'completed' | 'interrupted'; }
export interface RecordedDelegationGraphEdge { id: string; from: string; to: string; kind: 'assignment' | 'result-delivery'; provenance: DelegationGraphEvent['provenance']; state: 'moving' | 'paused' | 'stopped'; }
/** Projects only durable task links; it never invents agent traffic or performs work. */
export function delegationGraph(tasks: Task[]): DelegationGraphEdge[] {
  const byId = new Map(tasks.map(task => [task.id, task])); const edges: DelegationGraphEdge[] = [];
  const state = (task: Task): DelegationGraphEdge['state'] => task.schedule?.uncertain || task.state === 'interrupted' ? 'interrupted' : task.schedule?.state === 'blocked' || task.state === 'error' ? 'blocked' : task.state === 'running' ? 'running' : task.reviewedCommit ? 'completed' : 'queued';
  for (const child of tasks) { if (!child.delegation) continue; const parent = byId.get(child.delegation.parentId); if (!parent || parent.repository !== child.repository) continue; edges.push({ from: parent.id, to: child.id, kind: 'assignment', state: state(child) }); for (const dependency of child.delegation.dependencies) if (byId.has(dependency)) edges.push({ from: dependency, to: child.id, kind: 'dependency', state: state(child) }); }
  return edges;
}
/** Projects only supplied, validated lifecycle facts. It never creates an event from task state or a durable link. */
export function recordedDelegationGraphEdges(tasks: Task[], input: unknown): { edges: RecordedDelegationGraphEdge[]; approvalTargets: string[] } {
  const events = parseDelegationGraphEvents(input), byId = new Map(tasks.map(task => [task.id, task]));
  const approvalTargets = new Set(events.filter(event => {
    if (event.kind !== 'approval-pause' || event.to.kind !== 'task') return false;
    const child = byId.get(event.to.taskId);
    return child?.delegation?.parentId === event.parentId && child.delegation.runId === event.runId;
  }).map(event => (event.to as { kind: 'task'; taskId: string }).taskId));
  const edges = events.flatMap(event => {
    if ((event.kind !== 'assignment' && event.kind !== 'result-delivery') || event.from.kind !== 'task' || event.to.kind !== 'task') return [];
    const from = byId.get(event.from.taskId), to = byId.get(event.to.taskId); if (!from || !to || from.repository !== to.repository) return [];
    // A valid event alone never authorizes a visual agent route: it must still
    // name the immutable child->parent/run delegation receipt. Event v1 has no
    // lifecycle revision, so this projection does not infer time-based staleness.
    const child = event.kind === 'assignment' ? to : from, parent = event.kind === 'assignment' ? from : to;
    if (child.delegation?.parentId !== parent.id || child.delegation.runId !== event.runId || event.parentId !== parent.id) return [];
    const terminal = (task: Task) => task.state === 'discarded' || task.state === 'interrupted' || task.state === 'error' || !!task.reviewedCommit || task.schedule?.uncertain === true || task.schedule?.state === 'finished';
    const stopped = terminal(from) || terminal(to);
    return [{ id: event.id, from: from.id, to: to.id, kind: event.kind, provenance: event.provenance, state: stopped ? 'stopped' as const : approvalTargets.has(to.id) ? 'paused' as const : 'moving' as const }];
  });
  return { edges, approvalTargets: [...approvalTargets] };
}
