import { mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';

/**
 * Hydra helper jobs (docs/Official_Extensions_Plan.md, Phase 2).
 *
 * One store per workspace, one writer (this extension host), and one table of
 * allowed state changes. Every change is validated against the table, recorded in
 * the job's history, and written atomically, so a crash midway leaves the previous
 * file readable.
 */
export type JobState = 'queued' | 'starting' | 'running' | 'blocked' | 'checking' | 'done' | 'failed' | 'cancelled';
export const jobStates: readonly JobState[] = ['queued', 'starting', 'running', 'blocked', 'checking', 'done', 'failed', 'cancelled'];
export const finalJobStates: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled']);

/** The only allowed state changes. Anything else is refused. */
export const jobTransitions: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['blocked', 'checking', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  checking: ['done', 'running', 'failed', 'cancelled'],
  done: [],
  // The one way out of "failed": HelperService.continueWith sends a head that
  // failed on a usage limit back to queued, with the same worktree and branch.
  failed: ['queued'],
  cancelled: [],
};
export const canTransition = (from: JobState, to: JobState): boolean => jobTransitions[from].includes(to);

/** parseJobInput's cap on `brief`; HelperService.continueWith clips an appended handoff to the same limit. */
export const maxBriefLength = 32000;
export interface JobLimits { wallClockMs: number; maxTurns: number; maxBudgetUsd: number }
export const defaultJobLimits: JobLimits = { wallClockMs: 30 * 60_000, maxTurns: 60, maxBudgetUsd: 5 };

/** Raw values from Hydra's heads settings, before clamping. */
export interface HeadDefaultsInput { minutes?: number; maxTurns?: number; budgetUsd?: number }
const clampDefault = (value: unknown, fallback: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
/**
 * Resolve the default caps for a head started without explicit limits, from
 * Hydra's heads settings (hydra.heads.defaultMinutes/defaultMaxTurns/defaultBudgetUsd).
 * Pure so it is unit-testable; matches the package.json minimum/maximum for each setting.
 */
export function resolveHeadDefaults(input: HeadDefaultsInput): JobLimits {
  return {
    wallClockMs: clampDefault(input.minutes, 30, 1, 480) * 60_000,
    maxTurns: clampDefault(input.maxTurns, 60, 1, 500),
    maxBudgetUsd: clampDefault(input.budgetUsd, 5, 0.5, 100),
  };
}
/** How many times a head may report done before it fails, unless .hydra/gates.json says otherwise. */
export const defaultMaxAttempts = 3;
/** Gates (docs/Gates_Plan.md): what kind of gate a result is from, and how it ended. */
export type GateKind = 'command' | 'screenshots' | 'review';
export type GateState = 'passed' | 'failed' | 'notRun';
export type FindingSeverity = 'blocker' | 'major' | 'minor';
export interface GateFinding { file?: string; line?: number; severity: FindingSeverity; note: string }
/**
 * One gate's result: a command, the screenshots or a review. Results recorded
 * before gates existed have only the first six fields; read those through
 * gateKind and gateState. `passed` stays true only for a gate that passed.
 */
export interface JobCheckResult {
  id: string; required: boolean; passed: boolean; exitCode: number | null; durationMs: number; outputTail: string;
  kind?: GateKind; state?: GateState;
  /** Files that show what happened: the command's log, the reviewer's reply, the screenshots. */
  evidence?: string[];
  /** A review's findings. */
  findings?: GateFinding[];
  /** One line on the outcome: the review's summary, what the screenshots showed, or why the gate didn't run. */
  summary?: string;
  /** Who reviewed, for a review gate. */
  reviewer?: Provider;
}
export const gateKind = (check: JobCheckResult): GateKind => check.kind ?? 'command';
export const gateState = (check: JobCheckResult): GateState => check.state ?? (check.passed ? 'passed' : 'failed');
/** A gate that stops the work being accepted: required and failed. A gate that didn't run never blocks. */
export const gateBlocks = (check: JobCheckResult): boolean => check.required && gateState(check) === 'failed';

/**
 * A gate chip (docs/Gates_Plan.md, "Seeing results"): "✓ unit · ✓ review · ✗
 * ui", plus a not-run style with the reason on hover. Text as well as colour,
 * never colour alone — `tone` only ever adds colour on top of `label`'s icon.
 * Pure so both the Agents canvas and the Lanes tiles (and their SSR tests) use
 * the same reading of a result.
 */
export interface GateChipView { id: string; icon: '✓' | '✗' | '–'; label: string; tone: 'good' | 'bad' | 'neutral'; title: string }
export function gateChip(check: Pick<JobCheckResult, 'id' | 'kind' | 'state' | 'passed' | 'summary' | 'required'>): GateChipView {
  const state = gateState(check as JobCheckResult);
  const icon = state === 'passed' ? '✓' : state === 'notRun' ? '–' : '✗';
  const tone: GateChipView['tone'] = state === 'passed' ? 'good' : state === 'notRun' ? 'neutral' : 'bad';
  const title = state === 'notRun' ? (check.summary ? `Not run: ${check.summary}` : 'Not run') : (check.summary || (state === 'failed' ? 'Failed' : 'Passed'));
  return { id: check.id, icon, label: `${icon} ${check.id}`, tone, title };
}
export interface JobResult { summary: string; commit: string; changedFiles: string[]; checks: JobCheckResult[] }
export interface JobEvent { at: string; from: JobState | null; to: JobState; reason?: string }

/** The chat that started a job: one lead bridge (one Claude Code or Codex conversation). Set by Hydra from the caller's token. */
export interface JobLead {
  sessionId: string; provider?: Provider; label?: string;
  /** The Hydra lane that chat runs in, when it does (docs/Lanes_And_Planner_Plan.md). */
  lane?: string;
}
export interface Job {
  version: 1;
  id: string;
  /** Who started it: the lead of one Hydra window. Assigned by Hydra from the caller's token, never by the caller. */
  leadKey: string;
  lead?: JobLead;
  idempotencyKey: string;
  title: string;
  brief: string;
  writeScope: string[];
  provider: Provider;
  model?: string;
  dependsOn: string[];
  state: JobState;
  limits: JobLimits;
  /** Check attempts used, and the most allowed (the first run plus re-prompts). */
  attempts: number;
  maxAttempts: number;
  /** A helper that stops without reporting is nudged once, then failed. */
  nudged: boolean;
  /** Failed because its provider hit a usage limit (headLimitReason), not the head's own fault. Lets HelperService.continueWith find it, and clears once it does. */
  limitHit?: boolean;
  /** The helper's own git worktree, created when it starts. */
  worktree?: string;
  baseCommit?: string;
  branch?: string;
  question?: string;
  replies: { at: string; message: string }[];
  progress?: string;
  reason?: string;
  result?: JobResult;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  history: JobEvent[];
}

export interface JobInput {
  title: string; brief: string; writeScope: string[]; provider: Provider; model?: string;
  dependsOn?: string[]; idempotencyKey: string; limits?: Partial<JobLimits>;
  /** Optional name for the chat that started it, shown on the Agents canvas. */
  leadLabel?: string;
}

const text = (value: unknown, name: string, max: number, min = 1): string => {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${name} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Error(`${name} must be ${min}–${max} characters.`);
  return trimmed;
};
const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

/** A write-scope entry: a repository-relative path, never absolute or escaping the repository. */
export function parseWriteScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('write_scope must list 1–32 repository paths.');
  const scope = value.map(item => {
    const entry = text(item, 'write_scope entry', 300).replace(/\\/g, '/');
    if (path.posix.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.split('/').includes('..')) throw new Error(`write_scope entry "${entry}" must stay inside the repository.`);
    return entry === '.' ? '' : entry.replace(/^\.\//, '');
  });
  return [...new Set(scope)];
}

/** Validate what a lead asked for. Everything the provider sends is untrusted. */
export function parseJobInput(value: unknown): JobInput {
  if (!value || typeof value !== 'object') throw new Error('Job input must be an object.');
  const source = value as Record<string, unknown>;
  const provider = source.provider ?? 'claude';
  if (provider !== 'claude' && provider !== 'codex') throw new Error('provider must be "claude" or "codex".');
  const dependsOn = source.depends_on ?? source.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.length > 16 || dependsOn.some(item => typeof item !== 'string' || !/^[a-f0-9]{12}$/.test(item))) throw new Error('depends_on must list job ids.');
  const limits = (source.limits && typeof source.limits === 'object' ? source.limits : {}) as Record<string, unknown>;
  return {
    title: text(source.title, 'title', 200),
    brief: text(source.brief, 'brief', maxBriefLength),
    writeScope: parseWriteScope(source.write_scope ?? source.writeScope),
    provider,
    model: source.model === undefined ? undefined : text(source.model, 'model', 100),
    dependsOn: [...new Set(dependsOn as string[])],
    idempotencyKey: text(source.idempotency_key ?? source.idempotencyKey, 'idempotency_key', 200),
    leadLabel: source.lead_label === undefined ? undefined : text(source.lead_label, 'lead_label', 60),
    limits: {
      wallClockMs: limits.wall_clock_minutes === undefined ? undefined : clamp(Number(limits.wall_clock_minutes) * 60_000, defaultJobLimits.wallClockMs, 60_000, 4 * 3600_000),
      maxTurns: limits.max_turns === undefined ? undefined : clamp(limits.max_turns, defaultJobLimits.maxTurns, 1, 500),
      maxBudgetUsd: limits.max_budget_usd === undefined ? undefined : clamp(limits.max_budget_usd, defaultJobLimits.maxBudgetUsd, 0.1, 100),
    },
  };
}

interface StoreFile { version: 1; jobs: Job[] }

/**
 * The single writer of helper jobs for one workspace. Writes are serialized in
 * process and guarded across processes by a lock file whose owner pid is checked,
 * so a crashed writer never blocks the store for good.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date(), private readonly lockStaleMs = 30_000, private readonly getDefaultLimits: () => JobLimits = () => defaultJobLimits) {}
  get file(): string { return path.join(this.directory, 'jobs.json'); }
  private get lockFile(): string { return `${this.file}.lock`; }

  /** Load the store. A job that was starting, running or checking when Hydra stopped has lost its helper process, so it is failed with the reason. */
  async load(): Promise<Job[]> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      let parsed: StoreFile = { version: 1, jobs: [] };
      try { parsed = parseStoreFile(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Hydra head jobs could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      this.jobs = new Map(parsed.jobs.map(job => [job.id, job]));
      this.loaded = true;
      let changed = false;
      for (const job of this.jobs.values()) {
        if (job.state === 'starting' || job.state === 'running' || job.state === 'checking') { this.apply(job, 'failed', 'Hydra stopped while this head was running.'); changed = true; }
      }
      if (changed) await this.write();
      return this.list();
    });
  }

  list(leadKey?: string): Job[] { return [...this.jobs.values()].filter(job => !leadKey || job.leadKey === leadKey).map(job => structuredClone(job)); }
  get(id: string): Job | undefined { const job = this.jobs.get(id); return job && structuredClone(job); }

  /** Create a job, or return the existing one for a repeated idempotency key from the same lead. */
  async create(leadKey: string, input: JobInput, lead?: Omit<JobLead, 'label'>): Promise<{ job: Job; created: boolean }> {
    return this.serialize(async () => {
      this.assertLoaded();
      const existing = [...this.jobs.values()].find(job => job.leadKey === leadKey && job.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: structuredClone(existing), created: false };
      for (const dependency of input.dependsOn || []) {
        const found = this.jobs.get(dependency);
        if (!found || found.leadKey !== leadKey) throw new Error(`depends_on names an unknown job: ${dependency}.`);
      }
      const at = this.now().toISOString();
      let id: string; do { id = randomBytes(6).toString('hex'); } while (this.jobs.has(id));
      const limits = { ...this.getDefaultLimits(), ...Object.fromEntries(Object.entries(input.limits || {}).filter(([, value]) => value !== undefined)) } as JobLimits;
      const job: Job = {
        version: 1, id, leadKey, ...(lead ? { lead: { ...lead, ...(input.leadLabel ? { label: input.leadLabel } : {}) } } : {}),
        idempotencyKey: input.idempotencyKey, title: input.title, brief: input.brief, writeScope: input.writeScope,
        provider: input.provider, model: input.model, dependsOn: input.dependsOn || [], state: 'queued', limits, attempts: 0, maxAttempts: defaultMaxAttempts, nudged: false,
        replies: [], createdAt: at, updatedAt: at, history: [{ at, from: null, to: 'queued' }],
      };
      this.jobs.set(id, job);
      try { await this.write(); } catch (error) { this.jobs.delete(id); throw error; }
      return { job: structuredClone(job), created: true };
    });
  }

  /** Move a job to another state. Refused unless the table allows it. */
  async transition(id: string, to: JobState, reason?: string, patch: Partial<Omit<Job, 'id' | 'version' | 'leadKey' | 'state' | 'history'>> = {}): Promise<Job> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Unknown head job ${id}.`);
      if (!canTransition(job.state, to)) throw new Error(`Head job ${id} cannot go from ${job.state} to ${to}.`);
      const previous = structuredClone(job);
      Object.assign(job, patch);
      this.apply(job, to, reason);
      try { await this.write(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return structuredClone(job);
    });
  }

  /** Change fields that don't change state (progress, replies, worktree). Refused once a job is final. */
  async update(id: string, patch: Partial<Pick<Job, 'progress' | 'replies' | 'worktree' | 'baseCommit' | 'branch' | 'question' | 'nudged' | 'attempts' | 'maxAttempts'>>): Promise<Job> {
    return this.serialize(async () => {
      this.assertLoaded();
      const job = this.jobs.get(id);
      if (!job) throw new Error(`Unknown head job ${id}.`);
      if (finalJobStates.has(job.state)) throw new Error(`Head job ${id} is ${job.state}.`);
      const previous = structuredClone(job);
      Object.assign(job, patch, { updatedAt: this.now().toISOString() });
      try { await this.write(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return structuredClone(job);
    });
  }

  private apply(job: Job, to: JobState, reason?: string): void {
    const at = this.now().toISOString();
    job.history.push({ at, from: job.state, to, ...(reason ? { reason } : {}) });
    if (job.history.length > 200) job.history.splice(0, job.history.length - 200);
    if (to === 'running' && !job.startedAt) job.startedAt = at;
    if (finalJobStates.has(to)) job.finishedAt = at;
    job.state = to; job.updatedAt = at;
    if (reason !== undefined || finalJobStates.has(to)) job.reason = reason;
  }
  private assertLoaded(): void { if (!this.loaded) throw new Error('Hydra head jobs are not loaded yet.'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async write(): Promise<void> {
    await this.withLock(async () => {
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      const body: StoreFile = { version: 1, jobs: [...this.jobs.values()] };
      await writeFile(temporary, JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 });
      try { await replaceAtomic(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
    });
  }
  /** Cross-process guard. A lock whose owner is gone, or older than the stale limit, is removed. */
  private async withLock(work: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() })); } finally { await handle.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.clearStaleLock()) continue;
        if (attempt >= 100) throw new Error('Hydra head jobs are locked by another Hydra window.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { await work(); }
    finally {
      try { const owner = JSON.parse(await readFile(this.lockFile, 'utf8')); if (owner.token === token) await rm(this.lockFile, { force: true }); } catch { /* already gone */ }
    }
  }
  private async clearStaleLock(): Promise<boolean> {
    let owner: { pid?: number; at?: number };
    try { owner = JSON.parse(await readFile(this.lockFile, 'utf8')); } catch { owner = {}; }
    const alive = typeof owner.pid === 'number' && processAlive(owner.pid);
    const old = typeof owner.at !== 'number' || Date.now() - owner.at > this.lockStaleMs;
    if (alive && !old) return false;
    await rm(this.lockFile, { force: true });
    return true;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function parseStoreFile(value: unknown): StoreFile {
  const source = value as Partial<StoreFile>;
  if (!source || source.version !== 1 || !Array.isArray(source.jobs)) throw new Error('Unsupported head job store.');
  for (const job of source.jobs) {
    if (!job || job.version !== 1 || typeof job.id !== 'string' || !/^[a-f0-9]{12}$/.test(job.id) || !jobStates.includes(job.state) || !Array.isArray(job.history)) throw new Error('A stored head job is malformed.');
  }
  return { version: 1, jobs: source.jobs };
}
