import type { Task, ReviewedCommit } from './model';
import { BudgetHoldError } from './budgets';
import { reserveDelegatedExecution, startDelegatedExecution, validateDelegatedExecution } from './delegationRunner';

/** `enrolled` retains an approved dependency graph but has no launch request. */
export type ScheduleState = 'enrolled' | 'queued' | 'starting' | 'running' | 'waiting-for-approval' | 'waiting-for-children' | 'blocked' | 'interrupted' | 'finished' | 'cancelled';
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
  /** A durable child-result handoff identity. It makes restart reconciliation idempotent. */
  wakeupKey?: string;
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
  if (!s || typeof s !== 'object' || !['enrolled', 'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-children', 'blocked', 'interrupted', 'finished', 'cancelled'].includes(s.state) ||
    !Array.isArray(s.dependencies) || s.dependencies.length > 100 || !s.dependencies.every(id) || new Set(s.dependencies).size !== s.dependencies.length ||
    (s.startFromDependency !== undefined && !s.dependencies.includes(s.startFromDependency)) || !Array.isArray(s.artifacts) ||
    !s.artifacts.every(a => a && id(a.taskId) && s.dependencies.includes(a.taskId) && oid(a.commit) && oid(a.tree) && oid(a.baseCommit) && typeof a.reviewedAt === 'string' && Number.isFinite(Date.parse(a.reviewedAt))) ||
    (s.actualStartingCommit !== undefined && !oid(s.actualStartingCommit)) || (s.reason !== undefined && typeof s.reason !== 'string') ||
    (s.uncertain !== undefined && typeof s.uncertain !== 'boolean') ||
    (s.budgetHold !== undefined && (typeof s.budgetHold !== 'boolean' || s.budgetHold && (s.state !== 'blocked' || !s.request || s.uncertain))) ||
    (s.budgetWarnings !== undefined && (!Array.isArray(s.budgetWarnings) || s.budgetWarnings.length > 4 || !s.budgetWarnings.every(item => typeof item === 'string' && item.length <= 2000))) ||
    (s.queuedAt !== undefined && (typeof s.queuedAt !== 'string' || !Number.isFinite(Date.parse(s.queuedAt)))) ||
    (s.wakeupKey !== undefined && (typeof s.wakeupKey !== 'string' || !/^[a-f0-9]{64}$/.test(s.wakeupKey))) ||
    (s.request !== undefined && (!s.request || !['launch', 'terminal', 'startManaged', 'followUp'].includes(s.request.type) || (s.request.type === 'followUp' && (typeof s.request.prompt !== 'string' || !s.request.prompt.trim() || s.request.prompt.length > 32000 || s.request.prompt.includes('\0'))))) ||
    (s.state === 'waiting-for-children' && (s.request !== undefined || s.queuedAt !== undefined || s.uncertain || s.budgetHold || s.wakeupKey !== undefined)) ||
    (s.wakeupKey !== undefined && (!s.request || s.request.type !== 'followUp' || !['queued', 'starting', 'running', 'waiting-for-approval'].includes(s.state))) ||
    (s.state === 'enrolled' && (s.request !== undefined || s.startFromDependency !== undefined || s.artifacts.length !== 0 || s.actualStartingCommit !== undefined || s.queuedAt !== undefined || s.uncertain || s.budgetHold || s.budgetWarnings !== undefined || s.wakeupKey !== undefined))) throw new Error('Invalid task schedule. Original data has been retained.');
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
    reserve?(task: Task, request: LaunchRequest): Promise<boolean>;
    release?(task: Task): Promise<void>;
  }) {}
  async enqueue(task: Task, request: LaunchRequest): Promise<void> {
    if (task.state === 'discarded') throw new Error('Restore this discarded task before queueing a writer.');
    if (task.delegationJournalPending) throw new Error('Delegation assignment journal recovery is pending.');
    if (task.delegation && (!task.schedule || task.schedule.dependencies.length !== task.delegation.dependencies.length || task.schedule.dependencies.some((dependency, index) => dependency !== task.delegation!.dependencies[index]) || (!task.sessionId && (task.schedule.state !== 'enrolled' || task.schedule.request || task.schedule.uncertain)))) throw new Error('Delegated child must be explicitly enrolled with its immutable dependency graph before its first writer launch.');
    if (pendingSchedule(task)) throw new Error('This task already has queued work or an unreconciled writer.');
    const previousSchedule = task.schedule, previousExecution = task.delegationExecution;
    if (task.delegation) {
      if (request.type !== 'startManaged' && request.type !== 'followUp') throw new Error('Delegated children must use the managed scheduler launch path.');
      if (!task.sessionId) task.delegationExecution = reserveDelegatedExecution(task);
      else { validateDelegatedExecution(task); if (task.delegationExecution!.status === 'uncertain') throw new Error('Reconcile the delegated writer before resuming.'); }
    }
    task.schedule = { ...task.schedule, state: 'queued', dependencies: task.schedule?.dependencies || [], artifacts: task.schedule?.artifacts || [], request, queuedAt: new Date().toISOString(), reason: undefined, uncertain: false, budgetHold: undefined, budgetWarnings: undefined, wakeupKey: undefined };
    try { task.schedule.budgetWarnings = this.hooks.budget?.(task); }
    catch (error) { if (!(error instanceof BudgetHoldError)) throw error; this.hold(task, error); }
    try { await this.hooks.persist(); }
    catch (error) { task.schedule = previousSchedule; task.delegationExecution = previousExecution; throw error; }
    await this.drain();
  }
  /** Resume a suspended parent exactly once for a durable coalesced child-result set. */
  async resumeWaitingParent(task: Task, prompt: string, wakeupKey: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(wakeupKey) || !prompt.trim() || prompt.length > 32000 || prompt.includes('\0')) throw new Error('Invalid delegated parent wakeup.');
    const s = task.schedule;
    if (s?.wakeupKey === wakeupKey) return;
    if (!s || s.state !== 'waiting-for-children' || task.state === 'discarded') throw new Error('Parent is not waiting for delegated child results.');
    s.state = 'queued'; s.request = { type: 'followUp', prompt }; s.queuedAt = new Date().toISOString(); s.reason = undefined; s.wakeupKey = wakeupKey;
    try { await this.hooks.persist(); }
    catch (error) { s.state = 'waiting-for-children'; s.request = undefined; s.queuedAt = undefined; s.wakeupKey = undefined; throw error; }
    await this.drain();
  }
  reconcile(): void {
    for (const task of this.hooks.tasks()) {
      if (!task.schedule && (task.state === 'running' || task.state === 'external' && task.interface === 'interactive-cli')) task.schedule = { state: 'running', dependencies: [], artifacts: [] };
      if (task.schedule && activeStates.includes(task.schedule.state)) {
        if (task.delegationExecution && ['starting', 'sessioned'].includes(task.delegationExecution.status)) task.delegationExecution = { ...task.delegationExecution, status: 'uncertain', updatedAt: new Date().toISOString() };
        task.schedule.state = 'interrupted'; task.schedule.uncertain = true;
        task.schedule.reason = 'Hydra restarted during a launch or writer session. Stop any surviving process, then acknowledge reconciliation.';
      }
    }
  }
  async cancel(task: Task): Promise<void> {
    const s = task.schedule;
    if (!s || !['queued', 'starting', 'waiting-for-children', 'blocked', 'interrupted'].includes(s.state) || s.uncertain) throw new Error('Stop and reconcile this writer before cancelling queued work.');
    s.state = 'cancelled'; s.request = undefined; s.reason = 'Queued launch cancelled.'; s.budgetHold = undefined;
    if (task.delegationExecution) task.delegationExecution = { ...task.delegationExecution, status: 'stopped', updatedAt: new Date().toISOString() };
    await this.hooks.persist();
  }
  private hold(task: Task, error: BudgetHoldError): void {
    const s = task.schedule!;
    s.state = 'blocked'; s.budgetHold = true; s.reason = error.message; s.budgetWarnings = undefined;
  }
  async retryBudgetHold(task: Task): Promise<void> {
    const s = task.schedule;
    if (!s?.budgetHold || s.state !== 'blocked' || !s.request || s.uncertain || task.state === 'running' || task.state === 'external') throw new Error('This task has no stopped budget-held launch.');
    const warnings = this.hooks.budget?.(task);
    const previous = { ...s };
    if (s.request.type === 'startManaged' && task.sessionId) s.request = { type: 'followUp', prompt: task.prompt };
    s.state = 'queued'; s.budgetHold = undefined; s.reason = undefined; s.budgetWarnings = warnings;
    try { await this.hooks.persist(); }
    catch (error) { Object.assign(s, previous); throw error; }
    await this.drain();
  }
  async reconcileStopped(task: Task): Promise<void> {
    if (!task.schedule?.uncertain) throw new Error('This task has no uncertain writer.');
    task.schedule.uncertain = false; task.schedule.state = 'interrupted'; task.schedule.reason = 'Writer absence acknowledged. Queue a new launch or follow-up explicitly.';
    task.schedule.request = undefined;
    if (task.delegationExecution?.status === 'uncertain') task.delegationExecution = { ...task.delegationExecution, status: 'stopped', updatedAt: new Date().toISOString() };
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
      try { s.budgetWarnings = this.hooks.budget?.(task); }
      catch (error) { if (!(error instanceof BudgetHoldError)) throw error; this.hold(task, error); await this.hooks.persist(); continue; }
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
        s.budgetWarnings = this.hooks.budget?.(task);
        if (task.delegation && !task.sessionId) {
          startDelegatedExecution(task);
          // The dispatch attempt is durable before the host can create any provider process.
          try { await this.hooks.persist(); }
          catch (error) { startingSaveFailed = true; task.delegationExecution = { ...task.delegationExecution!, status: 'uncertain' }; s.uncertain = true; throw error; }
          if (cancelled() || !this.hooks.enabled()) continue;
        }
        await this.hooks.launch(task, s.request!);
        if (cancelled()) continue;
        if (s.budgetHold) { await this.hooks.persist(); continue; }
        s.state = task.state === 'error' ? 'blocked' : task.state === 'interrupted' ? 'interrupted' : task.state === 'idle' ? 'finished' : 'running';
        if (s.state === 'finished' || s.state === 'interrupted') s.request = undefined;
        s.reason = task.error;
        await this.hooks.persist();
      } catch (error) {
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
