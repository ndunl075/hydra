import { DependencyConflict, dependencyBase, type DependencyResult } from './headStart';
import type { JobState } from './jobs';
import type { LaneCloseMode, LaneState } from './lanes';
import {
  cycleMessage, findCycle, jobRunAs, jobStarted, planOutcomeReasonMax, planResultFilesMax, planResultNoteMax, topologicalOrder,
  type Plan, type PlanJob, type PlanJobOutcome, type PlanJobRunAs, type PlanStore,
} from './plans';

/**
 * Running a plan whose jobs are heads or lanes (docs/Plan_Lanes_Plan.md, section 2).
 *
 * `planSteps` is pure: from a plan and a look at its heads and lanes it gives each
 * job's status and what to do next. `PlanRunner` applies those steps on one queue
 * per plan, so two events never start the same job twice, and acts only through
 * injected starters, so tests use fakes. Nothing here knows about VS Code.
 */
export type PlanJobStatus = 'draft' | 'waiting' | 'active' | 'held' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** What the runner needs to know about one head. */
export interface PlanHeadLook {
  state: JobState; title: string; limitHit?: boolean; reason?: string; branch?: string;
  result?: { commit: string; summary: string; changedFiles: string[] };
}
/** What the runner needs to know about one lane, closed or not. */
export interface PlanLaneLook {
  name: string; state: LaneState; branch: string; baseCommit: string;
  /** The lane HEAD that Merge merged. */
  mergedHead?: string;
  closedAs?: LaneCloseMode;
}
/** The runner's view of this window's heads and lanes. */
export interface PlanLook {
  head(jobId: string): PlanHeadLook | undefined;
  /** Undefined once the lane is gone from the store. */
  lane(laneId: string): PlanLaneLook | undefined;
  /** Open lanes whose plan link names a job of this plan: a start whose record was never saved is adopted. */
  planLanes(planId: string): { laneId: string; jobKey: string; attempt: number }[];
  /** False while this window has no lanes (not a trusted Git folder, or they failed to start): lane jobs neither start nor fail then. */
  lanesAvailable(): boolean;
}

/** One job as the canvas and the Lanes view show it. */
export interface PlanJobView {
  key: string; runAs: PlanJobRunAs; status: PlanJobStatus;
  /** A plain-English line: "Waiting for Schema, Auth", "Schema did not finish.", "Lane closed before its job was done." */
  reason?: string;
  jobId?: string; laneId?: string;
  /** The work it handed on (a head's result, a lane's recorded result or merge). */
  commit?: string;
  /** A lane job that was ready while the window started: Start lane starts it. */
  startable?: boolean;
}
export type PlanRecord =
  | { key: string; kind: 'outcome'; outcome: Omit<PlanJobOutcome, 'at'> }
  | { key: string; kind: 'adopt'; laneId: string }
  | { key: string; kind: 'merged'; laneId: string; commit: string };
export interface PlanSteps {
  /** Every job, in the plan's order. */
  jobs: PlanJobView[];
  /** Facts to write down: skipped and failed jobs, adopted lanes, lanes done by merging. */
  record: PlanRecord[];
  /** Jobs to start now, dependencies first. */
  start: { key: string; runAs: PlanJobRunAs }[];
  /** What the plan's state becomes: done when every job is done; incomplete when nothing is left to wait for. */
  state: 'running' | 'done' | 'incomplete';
}
export interface PlanStepOptions {
  /** Lane jobs that were ready while the window started (keyed by job key): they wait for Start lane. */
  deferred?: ReadonlySet<string>;
  /** Why a job couldn't start yet, by job key ("Waiting: 24 lanes are open"). */
  waits?: ReadonlyMap<string, string>;
}

const ended: ReadonlySet<PlanJobStatus> = new Set(['failed', 'cancelled', 'skipped']);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Each job's status and the next steps (pure; docs/Plan_Lanes_Plan.md, "Job status" and "When a job starts").
 * - A lane job starts when every job it depends on is done.
 * - A head job starts when every lane job it depends on is done and every head job it depends on has
 *   started (HelperService then holds it until those heads are done). Jobs are walked dependencies
 *   first, so a chain of heads behind a lane is created in one pass.
 * - A job never starts after a dependency failed, was cancelled or was skipped: it is skipped. A held
 *   dependency (a head at its usage limit) makes it wait instead.
 */
export function planSteps(plan: Plan, look: PlanLook, options: PlanStepOptions = {}): PlanSteps {
  const byKey = new Map(plan.jobs.map(job => [job.key, job]));
  const cycle = findCycle(plan.jobs);
  const order = cycle ? plan.jobs.map(job => job.key).sort() : topologicalOrder(plan.jobs);
  const status = new Map<string, PlanJobStatus>();
  const views = new Map<string, PlanJobView>();
  const record: PlanRecord[] = [];
  const start: PlanSteps['start'] = [];
  const startingHeads = new Set<string>();
  const lanesAvailable = look.lanesAvailable();
  const adoptable = new Map<string, { laneId: string; attempt: number }>();
  if (lanesAvailable) for (const entry of look.planLanes(plan.id)) if (!adoptable.has(entry.jobKey)) adoptable.set(entry.jobKey, entry);
  const title = (key: string) => byKey.get(key)?.title ?? key;

  for (const key of order) {
    const job = byKey.get(key)!;
    const runAs = jobRunAs(job);
    const view: PlanJobView = { key, runAs, status: 'waiting', ...(job.jobId ? { jobId: job.jobId } : {}), ...(job.laneId ? { laneId: job.laneId } : {}) };
    views.set(key, view);
    const set = (next: PlanJobStatus, reason?: string) => { view.status = next; if (reason) view.reason = reason; status.set(key, next); };
    const fail = (reason: string) => { record.push({ key, kind: 'outcome', outcome: { state: 'failed', reason } }); set('failed', reason); };

    if (job.outcome) { set(job.outcome.state, job.outcome.reason); continue; }
    if (runAs === 'lane' && job.result) { view.commit = job.result.commit; set('done'); continue; }
    if (runAs === 'head' && job.jobId) {
      const head = look.head(job.jobId);
      if (!head) set('failed', 'Its head is gone from this window.');
      else if (head.state === 'done') { if (head.result) view.commit = head.result.commit; set('done'); }
      else if (head.state === 'failed' && head.limitHit) set('held', head.reason || 'Its agent hit a usage limit.');
      else if (head.state === 'failed') set('failed', head.reason || 'Its head failed.');
      else if (head.state === 'cancelled') set('cancelled', head.reason || 'Its head was cancelled.');
      else set('active');
      continue;
    }
    if (runAs === 'lane' && job.laneId) {
      // Without lanes in this window a lane can't be looked at: the job is neither done nor failed.
      if (!lanesAvailable) { set('active', 'Lanes aren\'t available in this window.'); continue; }
      const lane = look.lane(job.laneId);
      if (lane?.mergedHead) { record.push({ key, kind: 'merged', laneId: job.laneId, commit: lane.mergedHead }); view.commit = lane.mergedHead; set('done'); continue; }
      if (!lane || lane.state === 'closed') { fail(`Lane closed before its job was done${lane?.closedAs === 'keep' ? ` (branch ${lane.branch} kept)` : ''}.`); continue; }
      set('active');
      continue;
    }

    // ---- Not started ----
    if (job.draft) { set('draft', 'Added after the plan ran: Run plan starts it.'); continue; }
    // A lane whose plan link names this job, from a start whose record was never saved (a crash in between).
    const found = runAs === 'lane' ? adoptable.get(key) : undefined;
    if (found && found.attempt === (job.attempt ?? 0)) { record.push({ key, kind: 'adopt', laneId: found.laneId }); view.laneId = found.laneId; set('active'); continue; }
    const dependencies = job.dependsOn.filter(dependency => byKey.has(dependency));
    const broken = dependencies.find(dependency => ended.has(status.get(dependency)!));
    if (broken) {
      const reason = `${title(broken)} did not finish.`;
      record.push({ key, kind: 'outcome', outcome: { state: 'skipped', reason } });
      set('skipped', reason);
      continue;
    }
    if (cycle && cycle.includes(key)) { set('waiting', cycleMessage(plan.jobs, cycle)); continue; }
    const blocking = dependencies.filter(dependency => {
      const current = status.get(dependency);
      if (runAs === 'lane' || jobRunAs(byKey.get(dependency)!) === 'lane') return current !== 'done';
      // A head only needs its head dependencies started; a held one makes it wait, so giving up on that head skips it.
      return !(current === 'done' || (current === 'active' && (!!byKey.get(dependency)!.jobId || startingHeads.has(dependency))));
    });
    if (blocking.length) {
      const names = blocking.map(title).join(', ');
      set('waiting', runAs === 'lane' ? `Starts as a lane when ${names} ${blocking.length === 1 ? 'is' : 'are'} done` : `Waiting for ${names}`);
      continue;
    }
    if (runAs === 'head') { start.push({ key, runAs }); startingHeads.add(key); set('active', 'Starting…'); continue; }
    if (!lanesAvailable) { set('waiting', 'Waiting: lanes aren\'t available in this window.'); continue; }
    if (options.deferred?.has(key)) { view.startable = true; set('waiting', 'Ready to start: press Start lane.'); continue; }
    start.push({ key, runAs });
    set('waiting', options.waits?.get(key) ?? 'Starting…');
  }

  const jobs = plan.jobs.map(job => views.get(job.key)!);
  const state: PlanSteps['state'] = jobs.length && jobs.every(job => job.status === 'done') ? 'done'
    : start.length || jobs.some(job => job.status === 'waiting' || job.status === 'active' || job.status === 'held') ? 'running' : 'incomplete';
  return { jobs, record, start, state };
}

/**
 * Why Run plan must refuse up front, or undefined: a lane job needs a terminal, and this build may have none
 * (docs/Plan_Lanes_Plan.md, "When it can't start yet"). Names the lane jobs to switch to Head.
 */
export function planRunRefusal(plan: Pick<Plan, 'jobs'>, terminals: boolean): string | undefined {
  if (terminals) return undefined;
  const lanes = plan.jobs.filter(job => jobRunAs(job) === 'lane' && !jobStarted(job));
  return lanes.length ? `This build of Hydra has no terminals, so lane jobs can't run. Switch ${lanes.map(job => job.title).join(', ')} to Head.` : undefined;
}

/** A plan head's idempotency key: a retried head gets `-r<attempt>`, because the old key would return the old head. */
export const planHeadKey = (plan: Pick<Plan, 'id'>, job: Pick<PlanJob, 'key' | 'attempt'>): string => `plan-${plan.id}-${job.key}${job.attempt ? `-r${job.attempt}` : ''}`;

// ---- The runner ----

export interface PlanLaneStart {
  /** The commit the lane starts from: its dependencies' work, merged when there are several. Missing: the main checkout's HEAD. */
  baseCommit?: string;
  /** What the jobs it depends on handed on, for its first prompt. */
  dependencies: DependencyResult[];
}
export interface PlanRunnerOptions {
  store: Pick<PlanStore, 'get' | 'list' | 'update'>;
  look: PlanLook;
  /** The main checkout: a lane job's dependencies are merged into one starting commit here. */
  repository: string;
  /** Start a head job. `dependsOn` are the ids of the head jobs it depends on; `inputs` the results of its lane jobs. */
  startHead(plan: Plan, job: PlanJob, dependsOn: string[], inputs: DependencyResult[]): Promise<{ jobId: string }>;
  /** Start a lane job, or say why it has to wait (24 lanes open). */
  startLane(plan: Plan, job: PlanJob, start: PlanLaneStart): Promise<{ laneId: string } | { wait: string }>;
  /** Cancel job on a head job: stop the head (or give up on one held at its usage limit). */
  cancelHead(jobId: string, reason: string): Promise<void>;
  /** Cancel job on a lane job: the lane stays open, without its plan link. */
  unlinkLane(laneId: string): Promise<void>;
  /** The subjects of the commits between two commits (at most 10, newest first), for a lane's summary. */
  commitSubjects(from: string, to: string): Promise<string[]>;
  /** The files changed between two commits, for a lane job done by merging. */
  changedFiles(from: string, to: string): Promise<string[]>;
  /** A lane-job's lane needs a terminal: Run plan refuses without one. */
  terminalsAvailable(): boolean;
  /** A plan's jobs or statuses changed. */
  onChange?(planId: string): void;
  /** The runner started a plan's lane (the extension says so, with Show lane). */
  onLaneStarted?(plan: Plan, job: PlanJob, laneId: string): void;
  log?(line: string): void;
  now?(): Date;
  debounceMs?: number;
}

/** What Mark job done records (docs/Plan_Lanes_Plan.md, "What done means for a lane job"). */
export interface PlanLaneResultInput { commit: string; note?: string; changedFiles: string[] }

export class PlanRunner {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** `<planId>:<key>` of lane jobs that were ready while the window started. */
  private readonly deferred = new Set<string>();
  private readonly waits = new Map<string, string>();
  private readonly shown = new Map<string, string>();
  private readonly soon = new Set<string>();
  private soonAll = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly options: PlanRunnerOptions) {}

  /**
   * Run one plan's work in turn: every advance and every job action for a plan waits for the one
   * before it, so two events can't start the same job twice.
   */
  withPlan<T>(planId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(planId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    this.queues.set(planId, settled);
    void settled.then(() => { if (this.queues.get(planId) === settled) this.queues.delete(planId); });
    return run;
  }

  /** Apply one plan's steps until nothing more changes. `startup`: lane jobs that are ready wait for Start lane. */
  advance(planId: string, options: { startup?: boolean } = {}): Promise<void> {
    return this.withPlan(planId, () => this.pass(planId, options));
  }
  /** Every running plan (at startup, with `startup`). */
  async advanceAll(options: { startup?: boolean } = {}): Promise<void> {
    await Promise.all(this.options.store.list().filter(plan => plan.state === 'running').map(plan => this.advance(plan.id, options)));
  }
  /** Debounced (200 ms): after heads and lanes change. Without an id, every running plan. */
  advanceSoon(planId?: string): void {
    if (this.disposed) return;
    if (planId) this.soon.add(planId); else this.soonAll = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ids = this.soonAll ? this.options.store.list().filter(plan => plan.state === 'running').map(plan => plan.id) : [...this.soon];
      this.soon.clear(); this.soonAll = false;
      for (const id of ids) void this.advance(id).catch(error => this.options.log?.(`[plans] ${id}: ${describe(error)}`));
    }, this.options.debounceMs ?? 200);
    this.timer.unref?.();
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** Each job's status now (pure; for the canvas, the Lanes view and the Hydra panel). */
  statuses(planId: string): PlanJobView[] | undefined {
    const plan = this.options.store.get(planId);
    return plan && planSteps(plan, this.options.look, this.stepOptions(plan.id)).jobs;
  }
  /** The plan job a lane runs, if any: found by the job's lane id. */
  jobForLane(laneId: string): { plan: Plan; job: PlanJob; view: PlanJobView } | undefined {
    for (const plan of this.options.store.list()) {
      const job = plan.jobs.find(item => item.laneId === laneId);
      if (!job) continue;
      const view = planSteps(plan, this.options.look, this.stepOptions(plan.id)).jobs.find(item => item.key === job.key)!;
      return { plan, job, view };
    }
    return undefined;
  }

  // ---- Actions (each on the plan's queue) ----

  /**
   * Run plan: refuses a plan being drafted, a done or empty plan, a cycle and, without terminals, lane jobs.
   * Jobs added with + Job since the last run are released; jobs that already started never start again.
   */
  run(planId: string): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan) throw new Error(`No plan ${planId}.`);
      if (plan.state === 'planning') throw new Error('This plan is still being drafted.');
      if (plan.state === 'done') throw new Error('This plan is already done.');
      if (!plan.jobs.length) throw new Error('Add a job to this plan first.');
      const cycle = findCycle(plan.jobs);
      if (cycle) throw new Error(cycleMessage(plan.jobs, cycle));
      const refusal = planRunRefusal(plan, this.options.terminalsAvailable());
      if (refusal) throw new Error(refusal);
      await this.options.store.update(planId, current => ({ ...current, state: 'running', error: undefined, jobs: current.jobs.map(({ draft: _draft, ...job }) => job) }));
      await this.pass(planId, {});
    });
  }

  /** Retry failed jobs (incomplete → running): failed, cancelled and skipped jobs start again, each counting one more attempt. */
  retry(planId: string): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan) throw new Error(`No plan ${planId}.`);
      if (plan.state !== 'incomplete') throw new Error('Only an incomplete plan\'s jobs can be retried.');
      const again = new Set(planSteps(plan, this.options.look, this.stepOptions(planId)).jobs.filter(view => ended.has(view.status)).map(view => view.key));
      if (!again.size) throw new Error('This plan has no failed jobs to retry.');
      const refusal = planRunRefusal({ jobs: plan.jobs.filter(job => again.has(job.key)).map(job => ({ ...job, jobId: undefined, laneId: undefined, result: undefined, outcome: undefined })) }, this.options.terminalsAvailable());
      if (refusal) throw new Error(refusal);
      await this.options.store.update(planId, current => ({
        ...current, state: 'running',
        jobs: current.jobs.map(job => {
          if (!again.has(job.key)) return job;
          const { jobId: _jobId, laneId: _laneId, result: _result, outcome: _outcome, ...rest } = job;
          return { ...rest, attempt: (job.attempt ?? 0) + 1 };
        }),
      }));
      for (const key of again) { this.waits.delete(`${planId}:${key}`); this.deferred.delete(`${planId}:${key}`); }
      await this.pass(planId, {});
    });
  }

  /** Start lane, on a lane job that was ready while the window started. */
  startJob(planId: string, key: string): Promise<void> {
    return this.withPlan(planId, async () => {
      if (!this.deferred.delete(`${planId}:${key}`)) throw new Error('That job isn\'t waiting to be started.');
      await this.pass(planId, {});
    });
  }

  /**
   * Mark job done: record what a lane job hands on and start the jobs that wait for it. Pressing it
   * again moves the result forward, but only while no job that depends on it has started (decision 3).
   */
  markLaneDone(planId: string, key: string, laneId: string, input: PlanLaneResultInput): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      const job = plan?.jobs.find(item => item.key === key);
      if (!plan || !job || jobRunAs(job) !== 'lane' || job.laneId !== laneId) throw new Error('That lane doesn\'t run this plan job any more.');
      if (job.outcome) throw new Error(`Job ${job.title} has already ended.`);
      const started = plan.jobs.filter(item => item.dependsOn.includes(key) && (item.jobId || item.laneId || item.result));
      if (job.result && started.length) throw new Error(`${started.map(item => item.title).join(', ')} already started from ${job.result.commit.slice(0, 7)}, so this job's result can't move.`);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commit)) throw new Error('Mark job done needs a full commit id.');
      const note = input.note?.trim() ? clip(input.note.trim(), planResultNoteMax) : undefined;
      const result = { commit: input.commit, via: 'marked' as const, at: this.now().toISOString(), ...(note ? { note } : {}), changedFiles: input.changedFiles.slice(0, planResultFilesMax) };
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key ? { ...item, result } : item) }));
      await this.pass(planId, {});
    });
  }

  /**
   * Cancel job (docs/Plan_Lanes_Plan.md, "Failures"): a head is stopped (a held one given up on); a lane
   * stays open as an ordinary lane, without its plan link; the jobs that depend on it are skipped.
   */
  cancelJob(planId: string, key: string, reason = 'Cancelled.'): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      const job = plan?.jobs.find(item => item.key === key);
      if (!plan || !job) throw new Error('That job isn\'t in this plan.');
      const view = planSteps(plan, this.options.look, this.stepOptions(planId)).jobs.find(item => item.key === key)!;
      if (view.status === 'done') throw new Error(`Job ${job.title} is already done.`);
      if (ended.has(view.status)) throw new Error(`Job ${job.title} has already ended.`);
      const outcome: PlanJobOutcome = { state: 'cancelled', reason: clip(reason, planOutcomeReasonMax), at: this.now().toISOString() };
      if (job.jobId) await this.options.cancelHead(job.jobId, reason);
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !item.outcome && !item.result ? { ...item, outcome } : item) }));
      this.waits.delete(`${planId}:${key}`); this.deferred.delete(`${planId}:${key}`);
      if (job.laneId) await this.options.unlinkLane(job.laneId).catch(error => this.options.log?.(`[plans] ${planId}: couldn't unlink lane ${job.laneId}: ${describe(error)}`));
      await this.pass(planId, {});
    });
  }

  // ---- The pass ----

  private stepOptions(planId: string): PlanStepOptions {
    const prefix = `${planId}:`;
    const deferred = new Set([...this.deferred].filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)));
    const waits = new Map([...this.waits].filter(([id]) => id.startsWith(prefix)).map(([id, reason]) => [id.slice(prefix.length), reason]));
    return { deferred, waits };
  }

  private async pass(planId: string, options: { startup?: boolean }): Promise<void> {
    try {
      // Each round records what happened and starts what is ready; a start can make more ready (a
      // chain of heads is started in one round), and a failure can skip more, so repeat until quiet.
      for (let round = 0; round < 50 && !this.disposed; round++) {
        const plan = this.options.store.get(planId);
        if (!plan || plan.state !== 'running') break;
        const steps = planSteps(plan, this.options.look, this.stepOptions(planId));
        let progressed = false;
        if (steps.record.length) progressed = await this.record(planId, steps.record) || progressed;
        for (const step of steps.start) {
          if (step.runAs === 'lane' && options.startup) {
            // Hydra never opens a lane terminal while a window is starting: the job shows Start lane instead.
            this.deferred.add(`${planId}:${step.key}`);
            continue;
          }
          progressed = await this.startOne(planId, step.key) || progressed;
        }
        if (progressed) continue;
        if (steps.state !== 'running') {
          await this.options.store.update(planId, current => current.state === 'running' ? { ...current, state: steps.state } : undefined);
          this.options.log?.(`[plans] ${planId} is ${steps.state}`);
        }
        break;
      }
    } finally { this.notify(planId); }
  }

  /** Write down what planSteps found, on the plan as it is now (a record that no longer fits is dropped). */
  private async record(planId: string, records: readonly PlanRecord[]): Promise<boolean> {
    const at = this.now().toISOString();
    const merged = new Map<string, string[]>();
    for (const item of records) {
      if (item.kind !== 'merged') continue;
      const lane = this.options.look.lane(item.laneId);
      merged.set(item.key, lane ? (await this.options.changedFiles(lane.baseCommit, item.commit).catch(() => [])).slice(0, planResultFilesMax) : []);
    }
    let changed = false;
    await this.options.store.update(planId, current => {
      const jobs = current.jobs.map(job => {
        const item = records.find(entry => entry.key === job.key);
        if (!item || job.outcome || job.result) return job;
        // A skipped job never started; a failed one here is a lane that closed without a result.
        if (item.kind === 'outcome' && (item.outcome.state === 'skipped' ? !jobStarted(job) : !!job.laneId)) { changed = true; return { ...job, outcome: { ...item.outcome, reason: clip(item.outcome.reason, planOutcomeReasonMax), at } }; }
        if (item.kind === 'adopt' && !job.laneId && !job.jobId) { changed = true; return { ...job, laneId: item.laneId }; }
        if (item.kind === 'merged' && job.laneId === item.laneId) { changed = true; return { ...job, result: { commit: item.commit, via: 'merged' as const, at, changedFiles: merged.get(job.key) ?? [] } }; }
        return job;
      });
      return changed ? { ...current, jobs } : undefined;
    });
    return changed;
  }

  /** Start one job if it is still unstarted. True when something changed (it started, or failed to). */
  private async startOne(planId: string, key: string): Promise<boolean> {
    const plan = this.options.store.get(planId);
    const job = plan?.jobs.find(item => item.key === key);
    if (!plan || !job || plan.state !== 'running' || jobStarted(job) || job.draft) return false;
    const id = `${planId}:${key}`;
    try {
      if (jobRunAs(job) === 'head') {
        const headIds: string[] = [];
        for (const dependency of job.dependsOn) {
          const other = plan.jobs.find(item => item.key === dependency);
          if (!other || jobRunAs(other) !== 'head') continue;
          if (!other.jobId) return false; // started later in this round; the next round has its id
          headIds.push(other.jobId);
        }
        const inputs = await this.dependencyResults(plan, job, 'lane');
        const { jobId } = await this.options.startHead(plan, job, headIds, inputs);
        await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, jobId } : item) }));
        this.options.log?.(`[plans] ${planId} started head ${jobId} for job ${key}`);
        return true;
      }
      const dependencies = await this.dependencyResults(plan, job);
      const baseCommit = dependencies.length ? await dependencyBase(this.options.repository, job.title, dependencies) : undefined;
      const started = await this.options.startLane(plan, job, { ...(baseCommit ? { baseCommit } : {}), dependencies });
      if ('wait' in started) {
        const changed = this.waits.get(id) !== started.wait;
        this.waits.set(id, started.wait);
        if (changed) this.notify(planId);
        return false;
      }
      this.waits.delete(id);
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, laneId: started.laneId } : item) }));
      this.options.log?.(`[plans] ${planId} started lane ${started.laneId} for job ${key}`);
      this.options.onLaneStarted?.(plan, job, started.laneId);
      return true;
    } catch (error) {
      this.waits.delete(id);
      // A plan names its dependencies "jobs", whoever did them (docs/Plan_Lanes_Plan.md, "Starting a lane job").
      const reason = error instanceof DependencyConflict ? new DependencyConflict(error.files, 'jobs').message : `Couldn't start: ${describe(error)}`;
      this.options.log?.(`[plans] ${planId} job ${key}: ${reason}`);
      const outcome: PlanJobOutcome = { state: 'failed', reason: clip(reason, planOutcomeReasonMax), at: this.now().toISOString() };
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, outcome } : item) }));
      return true;
    }
  }

  /** What each job it depends on handed on, heads and lanes alike (or only lanes), in the order it names them. */
  private async dependencyResults(plan: Plan, job: PlanJob, only?: PlanJobRunAs): Promise<DependencyResult[]> {
    const results: DependencyResult[] = [];
    for (const key of job.dependsOn) {
      const other = plan.jobs.find(item => item.key === key);
      if (!other || (only && jobRunAs(other) !== only)) continue;
      if (jobRunAs(other) === 'lane') {
        if (!other.result || !other.laneId) throw new Error(`${other.title} has no result to start from.`);
        const lane = this.options.look.lane(other.laneId);
        const subjects = other.result.note ? [] : lane ? await this.options.commitSubjects(lane.baseCommit, other.result.commit).catch(() => []) : [];
        const summary = other.result.note || subjects.join('; ') || `Its work is in commit ${other.result.commit.slice(0, 12)}.`;
        results.push({ id: other.laneId, kind: 'lane', title: other.title, summary: clip(summary, 2000), commit: other.result.commit, ...(lane ? { branch: lane.branch } : {}), changedFiles: other.result.changedFiles });
      } else {
        const head = other.jobId ? this.options.look.head(other.jobId) : undefined;
        if (!head || head.state !== 'done' || !head.result) throw new Error(`${other.title} has no result to start from.`);
        results.push({ id: other.jobId!, kind: 'head', title: other.title, summary: clip(head.result.summary, 2000), commit: head.result.commit, ...(head.branch ? { branch: head.branch } : {}), changedFiles: head.result.changedFiles });
      }
    }
    return results;
  }

  /** Tell the extension when a plan's jobs or statuses changed since it last heard. */
  private notify(planId: string): void {
    const plan = this.options.store.get(planId);
    const text = JSON.stringify(plan ? { updatedAt: plan.updatedAt, state: plan.state, jobs: planSteps(plan, this.options.look, this.stepOptions(planId)).jobs } : null);
    if (this.shown.get(planId) === text) return;
    this.shown.set(planId, text);
    this.options.onChange?.(planId);
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}
