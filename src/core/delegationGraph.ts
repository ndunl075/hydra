import type { Task } from './model';
export interface DelegationGraphEdge { from: string; to: string; kind: 'assignment' | 'dependency'; state: 'queued' | 'running' | 'blocked' | 'completed' | 'interrupted'; }
/** Projects only durable task links; it never invents agent traffic or performs work. */
export function delegationGraph(tasks: Task[]): DelegationGraphEdge[] {
  const byId = new Map(tasks.map(task => [task.id, task])); const edges: DelegationGraphEdge[] = [];
  const state = (task: Task): DelegationGraphEdge['state'] => task.schedule?.uncertain || task.state === 'interrupted' ? 'interrupted' : task.schedule?.state === 'blocked' || task.state === 'error' ? 'blocked' : task.state === 'running' ? 'running' : task.reviewedCommit ? 'completed' : 'queued';
  for (const child of tasks) { if (!child.delegation) continue; const parent = byId.get(child.delegation.parentId); if (!parent || parent.repository !== child.repository) continue; edges.push({ from: parent.id, to: child.id, kind: 'assignment', state: state(child) }); for (const dependency of child.delegation.dependencies) if (byId.has(dependency)) edges.push({ from: dependency, to: child.id, kind: 'dependency', state: state(child) }); }
  return edges;
}
