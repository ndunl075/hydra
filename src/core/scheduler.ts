import type { Task, ReviewedCommit } from './model';

export type ScheduleState = 'queued' | 'starting' | 'running' | 'waiting-for-approval' | 'blocked' | 'interrupted' | 'finished' | 'cancelled';
export type LaunchRequest = { type: 'launch' | 'terminal' | 'startManaged' } | { type: 'followUp'; prompt: string };
export interface DependencyArtifact extends ReviewedCommit { taskId: string }
export interface TaskSchedule {
  state: ScheduleState;
  dependencies: string[];
  startFromDependency?: string;
  artifacts: DependencyArtifact[];
  request?: LaunchRequest;
  queuedAt?: string;
  actualStartingCommit?: string;
  reason?: string;
  /** A launch may have escaped the extension host. Holds capacity until explicit reconciliation. */
  uncertain?: boolean;
}
const activeStates = ['starting', 'running', 'waiting-for-approval'];
export const pendingSchedule = (task: Task): boolean => !!task.schedule && (['queued', 'blocked', ...activeStates].includes(task.schedule.state) || !!task.schedule.uncertain);

export function assertDependencyGraph(tasks: Task[], taskId: string, dependencies = tasks.find(task => task.id === taskId)?.schedule?.dependencies || []): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Task dependency cycle detected.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of id === taskId ? dependencies : tasks.find(item => item.id === id)?.schedule?.dependencies || []) visit(child);
    visiting.delete(id); visited.add(id);
  };
  visit(taskId);
}

export function validateSchedule(value: unknown): asserts value is TaskSchedule {
  const s = value as TaskSchedule;
  const oid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{40,64}$/.test(v);
  const id = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{12}$/.test(v);
  if (!s || typeof s !== 'object' || !['queued', 'starting', 'running', 'waiting-for-approval', 'blocked', 'interrupted', 'finished', 'cancelled'].includes(s.state) ||
    !Array.isArray(s.dependencies) || s.dependencies.length > 100 || !s.dependencies.every(id) || new Set(s.dependencies).size !== s.dependencies.length ||
    (s.startFromDependency !== undefined && !s.dependencies.includes(s.startFromDependency)) || !Array.isArray(s.artifacts) ||
    !s.artifacts.every(a => a && id(a.taskId) && s.dependencies.includes(a.taskId) && oid(a.commit) && oid(a.tree) && oid(a.baseCommit) && typeof a.reviewedAt === 'string' && Number.isFinite(Date.parse(a.reviewedAt))) ||
    (s.actualStartingCommit !== undefined && !oid(s.actualStartingCommit)) || (s.reason !== undefined && typeof s.reason !== 'string') ||
    (s.uncertain !== undefined && typeof s.uncertain !== 'boolean') ||
    (s.queuedAt !== undefined && (typeof s.queuedAt !== 'string' || !Number.isFinite(Date.parse(s.queuedAt)))) ||
    (s.request !== undefined && (!s.request || !['launch', 'terminal', 'startManaged', 'followUp'].includes(s.request.type) || (s.request.type === 'followUp' && (typeof s.request.prompt !== 'string' || !s.request.prompt.trim() || s.request.prompt.length > 32000 || s.request.prompt.includes('\0')))))) throw new Error('Invalid task schedule. Original data has been retained.');
}

export function configureSchedule(task: Task, tasks: Task[], dependencies: string[], startFromDependency?: string): void {
  if (task.schedule && (activeStates.includes(task.schedule.state) || task.schedule.uncertain)) throw new Error('Stop and reconcile this task writer before changing dependencies.');
  if (task.schedule?.actualStartingCommit && startFromDependency !== task.schedule.startFromDependency) throw new Error('The initial checkout cannot change after a launch. Create a new dependent task.');
  const candidate: TaskSchedule = { state: task.schedule?.request ? 'queued' : 'finished', dependencies, startFromDependency, artifacts: dependencies.flatMap(id => {
    const receipt = tasks.find(item => item.id === id)?.reviewedCommit;
    return receipt ? [{ taskId: id, ...receipt }] : [];
  }), request: task.schedule?.request, queuedAt: task.schedule?.queuedAt, actualStartingCommit: task.schedule?.actualStartingCommit };
  validateSchedule(candidate);
  for (const dependency of dependencies) {
    const predecessor = tasks.find(item => item.id === dependency);
    if (!predecessor || predecessor.repository !== task.repository) throw new Error('Dependencies must be tasks in the same repository.');
  }
  assertDependencyGraph(tasks, task.id, dependencies);
  task.schedule = candidate;
}

/** Persist before any preparation or provider launch. Uncertain writers never auto-retry. */
export class TaskScheduler {
  private draining?: Promise<void>;
  private requested = false;
  constructor(private readonly hooks: {
    tasks(): Task[]; capacity(): number; liveCount(): number; enabled(): boolean;
    persist(): Promise<void>;
    prepare(task: Task): Promise<{ commit: string; artifacts: DependencyArtifact[] }>;
    launch(task: Task, request: LaunchRequest): Promise<void>;
  }) {}
  async enqueue(task: Task, request: LaunchRequest): Promise<void> {
    if (pendingSchedule(task)) throw new Error('This task already has queued work or an unreconciled writer.');
    task.schedule = { ...task.schedule, state: 'queued', dependencies: task.schedule?.dependencies || [], artifacts: task.schedule?.artifacts || [], request, queuedAt: new Date().toISOString(), reason: undefined, uncertain: false };
    await this.hooks.persist();
    await this.drain();
  }
  reconcile(): void {
    for (const task of this.hooks.tasks()) {
      if (!task.schedule && (task.state === 'running' || task.state === 'external' && task.interface === 'interactive-cli')) task.schedule = { state: 'running', dependencies: [], artifacts: [] };
      if (task.schedule && activeStates.includes(task.schedule.state)) {
        task.schedule.state = 'interrupted'; task.schedule.uncertain = true;
        task.schedule.reason = 'Hydra restarted during a launch or writer session. Stop any surviving process, then acknowledge reconciliation.';
      }
    }
  }
  async cancel(task: Task): Promise<void> {
    const s = task.schedule;
    if (!s || !['queued', 'blocked', 'interrupted'].includes(s.state) || s.uncertain) throw new Error('Stop and reconcile this writer before cancelling queued work.');
    s.state = 'cancelled'; s.request = undefined; s.reason = 'Queued launch cancelled.';
    await this.hooks.persist();
  }
  async reconcileStopped(task: Task): Promise<void> {
    if (!task.schedule?.uncertain) throw new Error('This task has no uncertain writer.');
    task.schedule.uncertain = false; task.schedule.state = 'interrupted'; task.schedule.reason = 'Writer absence acknowledged. Queue a new launch or follow-up explicitly.';
    task.schedule.request = undefined;
    await this.hooks.persist(); await this.drain();
  }
  drain(): Promise<void> {
    this.requested = true;
    if (this.draining) return this.draining;
    this.draining = (async () => { do { this.requested = false; await this.run(); } while (this.requested); })().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async run(): Promise<void> {
    const tasks = [...this.hooks.tasks()].sort((a, b) => (a.schedule?.queuedAt || '').localeCompare(b.schedule?.queuedAt || ''));
    for (const task of tasks) {
      if (!this.hooks.enabled()) return;
      const held = this.hooks.tasks().filter(item => item.schedule?.uncertain).length;
      if (this.hooks.liveCount() + held >= this.hooks.capacity()) return;
      const s = task.schedule;
      if (!s || s.state !== 'queued' || !s.request) continue;
      try { assertDependencyGraph(this.hooks.tasks(), task.id); }
      catch (error) { s.state = 'blocked'; s.reason = String(error); await this.hooks.persist(); continue; }
      const dependency = s.dependencies.map(id => this.hooks.tasks().find(item => item.id === id));
      if (dependency.some(item => !item || item.state === 'error' || item.state === 'interrupted' || item.schedule?.state === 'cancelled' || item.schedule?.state === 'blocked' || item.schedule?.state === 'interrupted')) {
        s.state = 'blocked'; s.reason = 'A prerequisite failed, was interrupted, cancelled, or is missing. Resolve dependencies explicitly before retrying.';
        await this.hooks.persist(); continue;
      }
      if (dependency.some(item => item!.state === 'running' || item!.state === 'external' || pendingSchedule(item!) || !item!.reviewedCommit)) continue;
      s.state = 'starting'; s.reason = undefined;
      await this.hooks.persist();
      try {
        const prepared = await this.hooks.prepare(task);
        s.actualStartingCommit = prepared.commit; s.artifacts = prepared.artifacts;
        await this.hooks.persist();
        if (!this.hooks.enabled()) { s.state = 'interrupted'; s.reason = 'Launch cancelled before provider start.'; await this.hooks.persist(); return; }
        await this.hooks.launch(task, s.request);
        s.state = task.state === 'error' ? 'blocked' : task.state === 'interrupted' ? 'interrupted' : task.state === 'idle' ? 'finished' : 'running';
        if (s.state === 'finished' || s.state === 'interrupted') s.request = undefined;
        s.reason = task.error;
        await this.hooks.persist();
      } catch (error) {
        // A save can fail after process creation. Retain the live writer state so Stop still stops it.
        s.state = task.state === 'running' || task.state === 'external' ? 'running' : 'blocked';
        s.reason = error instanceof Error ? error.message : String(error);
        await this.hooks.persist();
      }
    }
  }
}
