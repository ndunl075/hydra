import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';

/**
 * Hydra plans (docs/Lanes_And_Planner_Plan.md, section 4). A plan is a small,
 * hand- or brief-drafted graph of jobs; running it starts each job as a Hydra
 * head, in dependency order, under one lead (`plan-<id>`) so the heads group
 * together on the canvas. Pure model and storage; nothing here starts a
 * process or knows about HelperService, so it is trivial to unit test.
 */
export type PlanState = 'planning' | 'draft' | 'running' | 'done' | 'failed';
export const planStates: readonly PlanState[] = ['planning', 'draft', 'running', 'done', 'failed'];
/** The only allowed plan state changes. "planning" is the brief being drafted; "failed" also covers a cancelled draft. */
export const planTransitions: Readonly<Record<PlanState, readonly PlanState[]>> = {
  planning: ['draft', 'failed'],
  draft: ['planning', 'running'],
  failed: ['planning', 'draft'],
  running: ['done'],
  done: [],
};
export const canTransitionPlan = (from: PlanState, to: PlanState): boolean => planTransitions[from].includes(to);

export const maxPlanJobs = 12;
export const planTitleMax = 200;
export const planBriefMax = 8000;
export const planJobTitleMax = 80;
export const planJobBriefMax = 4000;
export const planIdPattern = /^[a-f0-9]{12}$/;
export const planJobKeyPattern = /^[a-z0-9-]{1,24}$/;

export interface PlanJob {
  key: string; title: string; brief: string; provider?: Provider;
  dependsOn: string[]; writeScope?: string[];
  /** Set once this job has started as a head; makes running the plan again idempotent. */
  jobId?: string;
}
export interface Plan {
  version: 1; id: string; title: string; brief?: string; createdAt: string; updatedAt: string;
  state: PlanState; error?: string; jobs: PlanJob[];
}

const trimmed = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Unique keys that exist, dependencies that resolve, and the plan's size and text limits. Throws the first problem found. */
export function validatePlanJobs(jobs: readonly PlanJob[]): void {
  if (!Array.isArray(jobs)) throw new Error('A plan\'s jobs must be a list.');
  if (jobs.length > maxPlanJobs) throw new Error(`A plan may have at most ${maxPlanJobs} jobs.`);
  const keys = new Set<string>();
  for (const job of jobs) {
    if (typeof job.key !== 'string' || !planJobKeyPattern.test(job.key)) throw new Error(`Invalid job key "${String(job.key)}".`);
    if (keys.has(job.key)) throw new Error(`Duplicate job key "${job.key}".`);
    keys.add(job.key);
    if (!trimmed(job.title) || job.title.length > planJobTitleMax) throw new Error(`Job "${job.key}" title must be 1-${planJobTitleMax} characters.`);
    if (!trimmed(job.brief) || job.brief.length > planJobBriefMax) throw new Error(`Job "${job.key}" brief must be 1-${planJobBriefMax} characters.`);
    if (job.provider !== undefined && job.provider !== 'claude' && job.provider !== 'codex') throw new Error(`Job "${job.key}" has an unknown provider.`);
    if (!Array.isArray(job.dependsOn)) throw new Error(`Job "${job.key}" dependsOn must be a list.`);
  }
  for (const job of jobs) {
    for (const dependency of job.dependsOn) {
      if (!keys.has(dependency)) throw new Error(`Job "${job.key}" depends on unknown job "${dependency}".`);
      if (dependency === job.key) throw new Error(`Job "${job.key}" cannot depend on itself.`);
    }
  }
}

/** The plan's own fields, then its jobs. Throws the first problem found. */
export function validatePlan(plan: Plan): void {
  if (plan.version !== 1) throw new Error('Unsupported plan version.');
  if (typeof plan.id !== 'string' || !planIdPattern.test(plan.id)) throw new Error('Invalid plan id.');
  if (!trimmed(plan.title) || plan.title.length > planTitleMax) throw new Error(`Plan title must be 1-${planTitleMax} characters.`);
  if (plan.brief !== undefined && (typeof plan.brief !== 'string' || plan.brief.length > planBriefMax)) throw new Error(`Plan brief must be at most ${planBriefMax} characters.`);
  if (!planStates.includes(plan.state)) throw new Error('Invalid plan state.');
  validatePlanJobs(plan.jobs);
}

/**
 * The first dependency cycle, as a path like `['a', 'b', 'c', 'a']` (a depends
 * on b depends on c depends on a). `undefined` when the graph is acyclic.
 * Jobs whose dependsOn names an unknown key are treated as having no such
 * dependency here; validatePlanJobs is what refuses that.
 */
export function findCycle(jobs: readonly PlanJob[]): string[] | undefined {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = fully explored
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    state.set(key, 1);
    stack.push(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) {
      if (!byKey.has(dependency)) continue;
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) { const found = visit(dependency); if (found) return found; }
    }
    stack.pop();
    state.set(key, 2);
    return undefined;
  };
  for (const job of jobs) if (!state.has(job.key)) { const found = visit(job.key); if (found) return found; }
  return undefined;
}

/** The cycle as the live banner and the run-refusal message show it: job titles, arrow-joined. */
export function cycleMessage(jobs: readonly PlanJob[], cycle: readonly string[]): string {
  const titleOf = new Map(jobs.map(job => [job.key, job.title || job.key]));
  return `The plan has a dependency cycle: ${cycle.map(key => titleOf.get(key) || key).join(' → ')}`;
}

/** Dependencies before dependents; ties broken by key so the order is deterministic. Throws if the graph has a cycle. */
export function topologicalOrder(jobs: readonly PlanJob[]): string[] {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const remaining = new Map(jobs.map(job => [job.key, job.dependsOn.filter(dependency => byKey.has(dependency)).length]));
  const ready = jobs.filter(job => remaining.get(job.key) === 0).map(job => job.key).sort();
  const order: string[] = [];
  while (ready.length) {
    const key = ready.shift()!;
    order.push(key);
    for (const job of jobs) {
      if (!job.dependsOn.includes(key)) continue;
      const left = (remaining.get(job.key) ?? 0) - 1;
      remaining.set(job.key, left);
      if (left === 0) ready.push(job.key);
    }
    ready.sort();
  }
  if (order.length !== jobs.length) { const cycle = findCycle(jobs); throw new Error(cycle ? cycleMessage(jobs, cycle) : 'The plan has a dependency cycle.'); }
  return order;
}

/** The jobs still to start, in dependency order, skipping ones that already have a jobId: running a plan again after adding jobs starts only the new ones. */
export function jobsToStart(plan: Pick<Plan, 'jobs'>): PlanJob[] {
  const order = topologicalOrder(plan.jobs);
  const byKey = new Map(plan.jobs.map(job => [job.key, job]));
  return order.map(key => byKey.get(key)!).filter(job => !job.jobId);
}

/** True once every job has started and its head is done. A plan with no jobs is never "done" on its own. */
export function allJobsDone(plan: Pick<Plan, 'jobs'>, headState: (jobId: string) => string | undefined): boolean {
  return plan.jobs.length > 0 && plan.jobs.every(job => !!job.jobId && headState(job.jobId) === 'done');
}

/** Starts one plan job as a head; returns the id HelperService gave it. Dependencies are already-started head ids, resolved by the caller. */
export type PlanHeadStarter = (job: PlanJob, dependsOn: readonly string[]) => Promise<{ jobId: string }>;

/**
 * Run a plan: start every not-yet-started job, in dependency order, mapping
 * each job's `dependsOn` keys to the real head ids already recorded on this
 * plan. Refuses (without starting anything) if the jobs have a cycle.
 */
export async function runPlan(plan: Plan, start: PlanHeadStarter): Promise<Plan> {
  const cycle = findCycle(plan.jobs);
  if (cycle) throw new Error(cycleMessage(plan.jobs, cycle));
  const byKey = new Map(plan.jobs.map(job => [job.key, { ...job }]));
  for (const job of jobsToStart({ jobs: [...byKey.values()] })) {
    const current = byKey.get(job.key)!;
    const dependsOn = current.dependsOn.map(key => byKey.get(key)?.jobId).filter((id): id is string => !!id);
    const { jobId } = await start(current, dependsOn);
    current.jobId = jobId;
  }
  return { ...plan, jobs: [...byKey.values()], state: 'running' };
}

// ---- The planner-output parser (docs/Lanes_And_Planner_Plan.md, "Planning a brief") ----

const minPlannerJobs = 2, maxPlannerJobs = 8;

/** The first balanced `{...}` in the text, skipping over braces inside strings. `undefined` if none is well-formed JSON. Also reads a review gate's verdict. */
export function extractFirstJsonObject(text: string): string | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    try { JSON.parse(candidate); return candidate; } catch { /* not this one; keep scanning */ }
  }
  return undefined;
}
function matchingBrace(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') { depth--; if (depth === 0) return index; }
  }
  return -1;
}
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function parsePlanJobDraft(raw: unknown, index: number): PlanJob {
  if (!raw || typeof raw !== 'object') throw new Error(`Job ${index + 1} of the planner output must be an object.`);
  const source = raw as Record<string, unknown>;
  if (typeof source.key !== 'string' || !planJobKeyPattern.test(source.key)) throw new Error(`Job ${index + 1} of the planner output has an invalid key.`);
  if (!trimmed(source.title)) throw new Error(`Job "${source.key}" of the planner output is missing a title.`);
  if (!trimmed(source.brief)) throw new Error(`Job "${source.key}" of the planner output is missing a brief.`);
  const provider = source.provider === 'claude' || source.provider === 'codex' ? source.provider : undefined;
  const writeScope = stringList(source.writeScope);
  return {
    key: source.key, title: (source.title as string).trim().slice(0, planJobTitleMax), brief: (source.brief as string).trim().slice(0, planJobBriefMax),
    ...(provider ? { provider } : {}), dependsOn: stringList(source.dependsOn), ...(writeScope.length ? { writeScope } : {}),
  };
}

/**
 * Take the first JSON object out of a planner's reply text, validate it as
 * `{ "jobs": [...] }` with 2-8 jobs, and return the draft jobs. Tolerates code
 * fences and surrounding prose; throws with a plain-English reason otherwise.
 */
export function parsePlannerOutput(text: string): PlanJob[] {
  const object = extractFirstJsonObject(text);
  if (!object) throw new Error('The planner did not return a JSON object.');
  const parsed = JSON.parse(object) as { jobs?: unknown };
  if (!Array.isArray(parsed.jobs)) throw new Error('The planner output must have a "jobs" list.');
  if (parsed.jobs.length < minPlannerJobs || parsed.jobs.length > maxPlannerJobs) throw new Error(`The planner must return ${minPlannerJobs}-${maxPlannerJobs} jobs (it returned ${parsed.jobs.length}).`);
  const jobs = parsed.jobs.map(parsePlanJobDraft);
  validatePlanJobs(jobs);
  return jobs;
}

// ---- Storage: one JSON file per workspace, atomic writes, one writer (this extension host) ----

interface PlanStoreFile { version: 1; plans: Plan[] }
function parseStoreFile(value: unknown): PlanStoreFile {
  const source = value as Partial<PlanStoreFile>;
  if (!source || source.version !== 1 || !Array.isArray(source.plans)) throw new Error('Unsupported plan store.');
  for (const plan of source.plans) validatePlan(plan as Plan);
  return { version: 1, plans: source.plans };
}

export function createPlan(input: { title: string; brief?: string; state?: PlanState }): Plan {
  const at = new Date().toISOString();
  return { version: 1, id: randomBytes(6).toString('hex'), title: input.title, ...(input.brief ? { brief: input.brief } : {}), createdAt: at, updatedAt: at, state: input.state ?? 'draft', jobs: [] };
}

export class PlanStore {
  private plans = new Map<string, Plan>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}
  get file(): string { return path.join(this.directory, 'plans.json'); }

  /** Load the store. A plan left "planning" when Hydra stopped lost its planner process, so it is failed with the reason. */
  async load(): Promise<Plan[]> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      let parsed: PlanStoreFile = { version: 1, plans: [] };
      try { parsed = parseStoreFile(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Hydra plans could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      this.plans = new Map(parsed.plans.map(plan => [plan.id, plan]));
      this.loaded = true;
      let changed = false;
      for (const plan of this.plans.values()) {
        if (plan.state === 'planning') { plan.state = 'failed'; plan.error = 'Hydra stopped while this plan was being drafted.'; plan.updatedAt = this.now().toISOString(); changed = true; }
      }
      if (changed) await this.write();
      return this.list();
    });
  }

  list(): Plan[] { return [...this.plans.values()].map(plan => structuredClone(plan)); }
  get(id: string): Plan | undefined { const plan = this.plans.get(id); return plan && structuredClone(plan); }

  /** Validate and store a whole plan (create or replace). Used by every plan edit, and by the `hydra.plans.save` test command. */
  async save(plan: Plan): Promise<Plan> {
    return this.serialize(async () => {
      this.assertLoaded();
      validatePlan(plan);
      const next = structuredClone(plan);
      next.updatedAt = this.now().toISOString();
      const previous = this.plans.get(plan.id);
      this.plans.set(plan.id, next);
      try { await this.write(); } catch (error) { if (previous) this.plans.set(plan.id, previous); else this.plans.delete(plan.id); throw error; }
      return structuredClone(next);
    });
  }

  async remove(id: string): Promise<void> {
    return this.serialize(async () => {
      this.assertLoaded();
      const previous = this.plans.get(id);
      if (!previous) return;
      this.plans.delete(id);
      try { await this.write(); } catch (error) { this.plans.set(id, previous); throw error; }
    });
  }

  private assertLoaded(): void { if (!this.loaded) throw new Error('Hydra plans are not loaded yet.'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async write(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const body: PlanStoreFile = { version: 1, plans: [...this.plans.values()] };
    await writeFile(temporary, JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 });
    try { await replaceAtomic(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
