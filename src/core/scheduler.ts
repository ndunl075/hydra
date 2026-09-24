import type { Task, ReviewedCommit } from './model';
import { BudgetHoldError } from './budgets';

/** `enrolled` retains an approved dependency graph but has no launch request. */
export type ScheduleState = 'enrolled' | 'queued' | 'starting' | 'running' | 'waiting-for-approval' | 'blocked' | 'interrupted' | 'finished' | 'cancelled';
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
  budgetHold?: boolean;
  budgetWarnings?: string[];
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
  if (!s || typeof s !== 'object' || !['enrolled', 'queued', 'starting', 'running', 'waiting-for-approval', 'blocked', 'interrupted', 'finished', 'cancelled'].includes(s.state) ||
    !Array.isArray(s.dependencies) || s.dependencies.length > 100 || !s.dependencies.every(id) || new Set(s.dependencies).size !== s.dependencies.length ||
    (s.startFromDependency !== undefined && !s.dependencies.includes(s.startFromDependency)) || !Array.isArray(s.artifacts) ||
    !s.artifacts.every(a => a && id(a.taskId) && s.dependencies.includes(a.taskId) && oid(a.commit) && oid(a.tree) && oid(a.baseCommit) && typeof a.reviewedAt === 'string' && Number.isFinite(Date.parse(a.reviewedAt))) ||
    (s.actualStartingCommit !== undefined && !oid(s.actualStartingCommit)) || (s.reason !== undefined && typeof s.reason !== 'string') ||
    (s.uncertain !== undefined && typeof s.uncertain !== 'boolean') ||
    (s.budgetHold !== undefined && (typeof s.budgetHold !== 'boolean' || s.budgetHold && (s.state !== 'blocked' || !s.request || s.uncertain))) ||
    (s.budgetWarnings !== undefined && (!Array.isArray(s.budgetWarnings) || s.budgetWarnings.length > 4 || !s.budgetWarnings.every(item => typeof item === 'string' && item.length <= 2000))) ||
    (s.queuedAt !== undefined && (typeof s.queuedAt !== 'string' || !Number.isFinite(Date.parse(s.queuedAt)))) ||
    (s.request !== undefined && (!s.request || !['launch', 'terminal', 'startManaged', 'followUp'].includes(s.request.type) || (s.request.type === 'followUp' && (typeof s.request.prompt !== 'string' || !s.request.prompt.trim() || s.request.prompt.length > 32000 || s.request.prompt.includes('\0'))))) ||
    (s.state === 'enrolled' && (s.request !== undefined || s.startFromDependency !== undefined || s.artifacts.length !== 0 || s.actualStartingCommit !== undefined || s.queuedAt !== undefined || s.uncertain || s.budgetHold || s.budgetWarnings !== undefined))) throw new Error('Invalid task schedule. Original data has been retained.');
}

export function configureSchedule(task: Task, tasks: Task[], dependencies: string[], startFromDependency?: string): void {
  if (task.state === 'discarded' || dependencies.some(id => tasks.find(item => item.id === id)?.state === 'discarded')) throw new Error('Restore discarded tasks before configuring dependencies.');
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
    budget?(task: Task): string[];
    guardBudget?(task: Task, request: LaunchRequest): void;
    releaseBudgetGuard?(task: Task): void;
    reserve?(task: Task, request: LaunchRequest): Promise<boolean>;
    release?(task: Task): Promise<void>;
  }) {}
  async enqueue(task: Task, request: LaunchRequest): Promise<void> {
    if (task.state === 'discarded') throw new Error('Restore this discarded task before queueing a writer.');
    if (pendingSchedule(task)) throw new Error('This task already has queued work or an unreconciled writer.');
    const previousSchedule = task.schedule;
    task.schedule = { ...task.schedule, state: 'queued', dependencies: task.schedule?.dependencies || [], artifacts: task.schedule?.artifacts || [], request, queuedAt: new Date().toISOString(), reason: undefined, uncertain: false, budgetHold: undefined, budgetWarnings: undefined };
    try { this.hooks.guardBudget?.(task, request); task.schedule.budgetWarnings = this.hooks.budget?.(task); }
    catch (error) { if (!(error instanceof BudgetHoldError)) throw error; this.hooks.releaseBudgetGuard?.(task); this.hold(task, error); }
    try { await this.hooks.persist(); }
    catch (error) { task.schedule = previousSchedule; throw error; }
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
    if (!s || !['queued', 'starting', 'blocked', 'interrupted'].includes(s.state) || s.uncertain) throw new Error('Stop and reconcile this writer before cancelling queued work.');
    s.state = 'cancelled'; s.request = undefined; s.reason = 'Queued launch cancelled.'; s.budgetHold = undefined;
    this.hooks.releaseBudgetGuard?.(task);
    await this.hooks.persist();
  }
  private hold(task: Task, error: BudgetHoldError): void {
    const s = task.schedule!;
    s.state = 'blocked'; s.budgetHold = true; s.reason = error.message; s.budgetWarnings = undefined;
  }
  async retryBudgetHold(task: Task): Promise<void> {
    const s = task.schedule;
    if (!s?.budgetHold || s.state !== 'blocked' || !s.request || s.uncertain || task.state === 'running' || task.state === 'external') throw new Error('This task has no stopped budget-held launch.');
    await this.requeueBlocked(task);
  }
  /**
   * Queue a launch that failed and left its schedule blocked (a provider error at
   * startup, say) again with the same request. Without this, a blocked launch
   * could only be cancelled.
   */
  async retryBlocked(task: Task): Promise<void> {
    const s = task.schedule;
    if (!s || s.state !== 'blocked' || !s.request || s.uncertain || task.state === 'running' || task.state === 'external') throw new Error('This task has no stopped launch to retry.');
    await this.requeueBlocked(task);
  }
  private async requeueBlocked(task: Task): Promise<void> {
    const s = task.schedule!;
    if (!s.request) throw new Error('This task has no stopped launch to retry.');
    const previous = structuredClone(s);
    const restore = () => { Object.assign(s, previous); };
    if (s.request.type === 'startManaged' && task.sessionId) s.request = { type: 'followUp', prompt: task.prompt };
    let warnings: string[];
    try { this.hooks.guardBudget?.(task, s.request); warnings = this.hooks.budget?.(task) || []; }
    catch (error) { this.hooks.releaseBudgetGuard?.(task); restore(); throw error; }
    s.state = 'queued'; s.budgetHold = undefined; s.reason = undefined; s.budgetWarnings = warnings; s.queuedAt = new Date().toISOString();
    try { await this.hooks.persist(); }
    catch (error) { this.hooks.releaseBudgetGuard?.(task); restore(); throw error; }
    await this.drain();
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
  async idle(): Promise<void> { await this.draining; }
  private async run(): Promise<void> {
    const tasks = [...this.hooks.tasks()].sort((a, b) => (a.schedule?.queuedAt || '').localeCompare(b.schedule?.queuedAt || ''));
    for (const task of tasks) {
      if (!this.hooks.enabled()) return;
      const s = task.schedule;
      if (!s || s.state !== 'queued' || !s.request) continue;
      try { this.hooks.guardBudget?.(task, s.request); s.budgetWarnings = this.hooks.budget?.(task); }
      catch (error) { if (!(error instanceof BudgetHoldError)) throw error; this.hooks.releaseBudgetGuard?.(task); this.hold(task, error); await this.hooks.persist(); continue; }
      const held = this.hooks.tasks().filter(item => item.schedule?.uncertain).length;
      if (this.hooks.liveCount() + held >= this.hooks.capacity()) continue;
      try { assertDependencyGraph(this.hooks.tasks(), task.id); }
      catch (error) { s.state = 'blocked'; s.reason = String(error); await this.hooks.persist(); continue; }
      const dependency = s.dependencies.map(id => this.hooks.tasks().find(item => item.id === id));
      if (dependency.some(item => !item || item.state === 'discarded' || item.state === 'error' || item.state === 'interrupted' || item.schedule?.state === 'cancelled' || item.schedule?.state === 'blocked' || item.schedule?.state === 'interrupted')) {
        s.state = 'blocked'; s.reason = 'A prerequisite failed, was interrupted, cancelled, or is missing. Resolve dependencies explicitly before retrying.';
        await this.hooks.persist(); continue;
      }
      if (dependency.some(item => item!.state === 'running' || item!.state === 'external' || pendingSchedule(item!) || !item!.reviewedCommit)) continue;
      const cancelled = () => task.schedule !== s || s.state === 'cancelled' || !s.request;
      let startingSaveFailed = false;
      try {
        if (this.hooks.reserve && !await this.hooks.reserve(task, s.request)) {
          if (!cancelled() && s.reason !== 'Waiting for a shared profile slot.') { s.reason = 'Waiting for a shared profile slot.'; await this.hooks.persist(); }
          continue;
        }
        if (cancelled() || !this.hooks.enabled()) continue;
        s.state = 'starting'; s.reason = undefined;
        try { await this.hooks.persist(); } catch (error) { startingSaveFailed = true; throw error; }
        const prepared = await this.hooks.prepare(task);
        // Preparation can fast-forward the checkout. Retain reconciled base metadata even if Stop arrived meanwhile.
        if (cancelled()) { await this.hooks.persist(); continue; }
        s.actualStartingCommit = prepared.commit; s.artifacts = prepared.artifacts;
        await this.hooks.persist();
        if (cancelled()) continue;
        const reservations = this.hooks.tasks().filter(item => item.schedule?.uncertain).length;
        if (!this.hooks.enabled() || this.hooks.liveCount() + reservations >= this.hooks.capacity()) {
          s.state = 'queued'; s.reason = 'Waiting for task operations or capacity before provider start.';
          await this.hooks.persist(); return;
        }
        this.hooks.guardBudget?.(task, s.request);
        try { s.budgetWarnings = this.hooks.budget?.(task); }
        catch (error) { this.hooks.releaseBudgetGuard?.(task); throw error; }
        await this.hooks.launch(task, s.request!);
        this.hooks.releaseBudgetGuard?.(task);
        if (cancelled()) continue;
        if (s.budgetHold) { await this.hooks.persist(); continue; }
        s.state = task.state === 'error' ? 'blocked' : task.state === 'interrupted' ? 'interrupted' : task.state === 'idle' ? 'finished' : 'running';
        if (s.state === 'finished' || s.state === 'interrupted') s.request = undefined;
        s.reason = task.error;
        await this.hooks.persist();
      } catch (error) {
        this.hooks.releaseBudgetGuard?.(task);
        if (cancelled()) continue;
        if (startingSaveFailed) { s.state = 'blocked'; s.reason = error instanceof Error ? error.message : String(error); throw error; }
        if (error instanceof BudgetHoldError && task.state !== 'running' && task.state !== 'external') {
          this.hold(task, error); await this.hooks.persist(); continue;
        }
        // A save can fail after process creation. Retain the live writer state so Stop still stops it.
        s.state = task.state === 'running' || task.state === 'external' ? 'running' : 'blocked';
        s.reason = error instanceof Error ? error.message : String(error);
        await this.hooks.persist();
      } finally { await this.hooks.release?.(task); }
    }
  }
}
