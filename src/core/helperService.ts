import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git';
import { createWorktree } from './worktrees';
import { runCheckCommand } from './checkCommand';
import { finalJobStates, parseJobInput, type Job, type JobCheckResult, type JobStore } from './jobs';
import type { HelperCaller, HelperEndpoint } from './helperEndpoint';
import type { HelperRun, StartHelperRun } from './helperRunner';
import type { Provider } from './model';

/**
 * Hydra helpers, end to end (docs/Official_Extensions_Plan.md, Phases 4 and 6).
 * Every action from the endpoint lands here. Hydra's code, not a model, drives the
 * chain: start the helper, enforce its limits, check its work when it reports, and
 * hand the result back to the lead through hydra_wait_for_helpers.
 */
export interface HelperCheck { id: string; command: string[]; timeoutSeconds: number; required: boolean }
export interface HelperServiceOptions {
  store: JobStore;
  endpoint: Pick<HelperEndpoint, 'issue' | 'revokeJob' | 'port'>;
  /** The window's folder: the lead's working copy. Helpers branch from its HEAD, and its .hydra/checks.json is used. */
  leadFolder: string;
  leadKey: string;
  worktreeRoot?: () => string | undefined;
  startRun: StartHelperRun;
  /** The provider CLI to run, already version-checked; throws a clear reason if unusable. */
  executable: (provider: Provider) => Promise<string>;
  /** How a CLI starts the bridge (Hydra's executable as Node plus dist/hydra-mcp.cjs). */
  bridge: { command: string; args: string[]; env?: Record<string, string> };
  logDirectory: string;
  maxConcurrent: () => number;
  onChange?: () => void;
  log?: (line: string) => void;
  now?: () => number;
  watchdogMs?: number;
}

interface Active { run: HelperRun; token: string; startedAt: number; blockedSince?: number; blockedTotal: number; answer?: (reply: string) => void }
const maxChecksOutput = 2000;
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

export class HelperService {
  private readonly active = new Map<string, Active>();
  /** Every process Hydra started for a helper or its checks. None of them, or their children, may act as a lead. */
  private readonly helperPids = new Set<number>();
  private readonly waiters = new Set<() => void>();
  private dispatching = false;
  private dispatchAgain = false;
  private dispatchRun: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  constructor(private readonly options: HelperServiceOptions) {
    this.now = options.now || Date.now;
    this.watchdog = setInterval(() => { void this.enforceLimits(); }, options.watchdogMs ?? 5000);
    this.watchdog.unref?.();
  }

  /** After a restart no helper process survives, so a helper that was waiting for an answer can't continue. */
  async recover(): Promise<void> {
    for (const job of this.options.store.list(this.options.leadKey)) {
      if (job.state === 'blocked') await this.options.store.transition(job.id, 'failed', 'Hydra restarted while this helper was waiting for an answer.').catch(() => {});
    }
    this.changed();
    void this.dispatch();
  }

  /** The endpoint handler. */
  async handle(caller: HelperCaller, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (caller.leadKey !== this.options.leadKey) throw new Error('This Hydra window does not own that caller.');
    if (caller.role === 'lead') {
      switch (tool) {
        case 'hydra_start_helper': return this.startHelper(args);
        case 'hydra_wait_for_helpers': return this.waitForHelpers(args, signal);
        case 'hydra_get_helper': return this.describe(this.ownJob(args.job_id), true);
        case 'hydra_list_helpers': return { helpers: this.options.store.list(this.options.leadKey).map(job => this.describe(job, false)) };
        case 'hydra_reply_to_helper': return this.reply(args);
        case 'hydra_cancel_helper': return this.cancel(this.ownJob(args.job_id).id, typeof args.reason === 'string' ? clip(args.reason, 500) : 'Cancelled by the lead.');
      }
    } else {
      const jobId = caller.jobId!;
      switch (tool) {
        case 'hydra_done': return this.done(jobId, args);
        case 'hydra_stuck': return this.stuck(jobId, args, signal);
        case 'hydra_progress': return this.progress(jobId, args);
      }
    }
    throw new Error(`Unknown Hydra action ${tool}.`);
  }

  list(): Job[] { return this.options.store.list(this.options.leadKey); }
  helperProcessIds(): ReadonlySet<number> { return this.helperPids; }
  get leadFolder(): string { return this.options.leadFolder; }

  async stopAll(reason = 'Stopped with "Stop all helpers".'): Promise<number> {
    const open = this.list().filter(job => !finalJobStates.has(job.state));
    await Promise.all(open.map(job => this.cancel(job.id, reason).catch(() => undefined)));
    return open.length;
  }

  /** Window closing: stop every helper and record why. */
  async dispose(): Promise<void> {
    this.disposed = true; clearInterval(this.watchdog);
    await this.dispatchRun.catch(() => undefined);
    await Promise.all([...this.active.keys()].map(id => this.finish(id, 'failed', 'The Hydra window closed while this helper was running.').catch(() => undefined)));
    for (const job of this.list()) if (job.state === 'queued') await this.options.store.transition(job.id, 'failed', 'The Hydra window closed before this helper started.').catch(() => undefined);
    this.changed();
  }

  // ---- lead actions ----

  private async startHelper(args: Record<string, unknown>) {
    const input = parseJobInput(args);
    const open = this.list().filter(job => !finalJobStates.has(job.state)).length;
    if (open >= 16) throw new Error('This window already has 16 unfinished helpers. Wait for some to finish or cancel them.');
    const head = (await git(this.options.leadFolder, ['rev-parse', 'HEAD'])).trim();
    const dirty = (await git(this.options.leadFolder, ['status', '--porcelain=v1', '--untracked-files=no'])).trim();
    const { job, created } = await this.options.store.create(this.options.leadKey, input);
    if (created) await this.options.store.update(job.id, { baseCommit: head });
    this.changed();
    void this.dispatch();
    return {
      job_id: job.id, state: job.state, created,
      base_commit: created ? head : job.baseCommit,
      ...(created && dirty ? { warning: 'Your folder has uncommitted changes. The helper starts from the last commit and will not see them; commit first if it needs them.' } : {}),
    };
  }

  private async waitForHelpers(args: Record<string, unknown>, signal: AbortSignal) {
    const ids = args.job_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16) throw new Error('job_ids must list 1–16 helper job ids.');
    const jobs = ids.map(id => this.ownJob(id));
    const maxWait = Math.max(1, Math.min(3000, typeof args.max_wait_s === 'number' ? args.max_wait_s : 1800)) * 1000;
    const settled = () => jobs.every(job => { const current = this.options.store.get(job.id)!; return finalJobStates.has(current.state) || current.state === 'blocked'; });
    const deadline = this.now() + maxWait;
    while (!settled() && !signal.aborted && this.now() < deadline) {
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, Math.min(5000, Math.max(1, deadline - this.now())));
        this.waiters.add(wake); signal.addEventListener('abort', wake, { once: true });
      });
    }
    const current = jobs.map(job => this.describe(this.options.store.get(job.id)!, true));
    return { all_settled: settled(), helpers: current };
  }

  private async reply(args: Record<string, unknown>) {
    const job = this.ownJob(args.job_id);
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 8000) throw new Error('message must be 1–8000 characters.');
    const active = this.active.get(job.id);
    if (job.state !== 'blocked' || !active?.answer) throw new Error(`Helper ${job.id} is not waiting for an answer (it is ${job.state}).`);
    await this.options.store.update(job.id, { replies: [...job.replies, { at: new Date(this.now()).toISOString(), message: args.message }] });
    active.answer(args.message);
    return { job_id: job.id, delivered: true };
  }

  private async cancel(id: string, reason: string) {
    const job = this.options.store.get(id)!;
    if (finalJobStates.has(job.state)) return { job_id: id, state: job.state };
    if (this.active.has(id)) await this.finish(id, 'cancelled', reason);
    else await this.options.store.transition(id, 'cancelled', reason);
    this.changed();
    void this.dispatch();
    return { job_id: id, state: 'cancelled' };
  }

  // ---- helper actions ----

  private async done(jobId: string, args: Record<string, unknown>) {
    const job = this.options.store.get(jobId);
    if (!job || job.state !== 'running') throw new Error(`This helper can't report done while it is ${job?.state ?? 'unknown'}.`);
    if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('summary is required.');
    const summary = clip(args.summary.trim(), 8000);
    const worktree = job.worktree!, base = job.baseCommit!;
    // Hydra commits whatever the helper left uncommitted. Codex's Windows sandbox
    // can't write a worktree's .git metadata, so a helper may be unable to commit.
    if ((await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) await commitAll(worktree, `${job.title} (Hydra helper ${job.id})`);
    const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
    if (commit === base) return { accepted: false, message: 'You have not changed anything yet. Make the changes, then call hydra_done again.' };
    const changedFiles = (await git(worktree, ['diff', '--name-only', '-z', '--no-renames', base, commit, '--'])).split('\0').filter(Boolean);
    const outside = changedFiles.filter(file => !inScope(file, job.writeScope));
    await this.options.store.transition(jobId, 'checking');
    this.changed();
    const attempts = job.attempts + 1;
    if (outside.length) return this.checkFailed(jobId, attempts, `These files are outside your write scope (${job.writeScope.join(', ') || '(whole repository)'}):\n${outside.join('\n')}\nUndo those changes in a new commit, then call hydra_done again.`);
    const checks = await this.runChecks(job, attempts);
    const failed = checks.filter(check => check.required && !check.passed);
    if (failed.length) return this.checkFailed(jobId, attempts, `Checks failed:\n${failed.map(check => `- ${check.id} (exit ${check.exitCode ?? 'none'}):\n${check.outputTail}`).join('\n')}\nFix them, commit, and call hydra_done again.`, checks);
    await this.options.store.update(jobId, { attempts });
    await this.options.store.transition(jobId, 'done', undefined, { result: { summary, commit, changedFiles, checks } });
    this.changed();
    return { accepted: true, message: 'Accepted. Your work is recorded for the lead. Stop now.' };
  }

  private async checkFailed(jobId: string, attempts: number, message: string, checks: JobCheckResult[] = []) {
    const job = this.options.store.get(jobId)!;
    await this.options.store.update(jobId, { attempts });
    if (attempts >= job.maxAttempts) {
      await this.options.store.transition(jobId, 'failed', `Checks failed ${attempts} times.`, { result: { summary: 'Not accepted: checks kept failing.', commit: (await git(job.worktree!, ['rev-parse', 'HEAD'])).trim(), changedFiles: [], checks } });
      this.changed();
      void this.stopRun(jobId);
      return { accepted: false, message: `${message}\n\nThat was the last attempt (${attempts} of ${job.maxAttempts}). Stop now; the lead will see the failure.` };
    }
    await this.options.store.transition(jobId, 'running', `Checks failed (attempt ${attempts} of ${job.maxAttempts}).`);
    this.changed();
    return { accepted: false, attempt: attempts, attempts_left: job.maxAttempts - attempts, message };
  }

  private async stuck(jobId: string, args: Record<string, unknown>, signal: AbortSignal) {
    const job = this.options.store.get(jobId), active = this.active.get(jobId);
    if (!job || job.state !== 'running' || !active) throw new Error(`This helper can't ask a question while it is ${job?.state ?? 'unknown'}.`);
    const reason = typeof args.reason === 'string' && args.reason.trim() ? clip(args.reason.trim(), 2000) : 'Blocked.';
    const question = typeof args.question === 'string' && args.question.trim() ? clip(args.question.trim(), 2000) : reason;
    await this.options.store.transition(jobId, 'blocked', reason, { question });
    active.blockedSince = this.now();
    this.changed();
    const answer = await new Promise<string | undefined>(resolve => {
      active.answer = reply => resolve(reply);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    active.answer = undefined;
    if (active.blockedSince !== undefined) { active.blockedTotal += this.now() - active.blockedSince; active.blockedSince = undefined; }
    const current = this.options.store.get(jobId)!;
    if (answer === undefined || current.state !== 'blocked') return { answered: false, message: 'No answer is coming: this helper was stopped. Stop now.' };
    await this.options.store.transition(jobId, 'running', 'The lead answered.', { question: undefined });
    this.changed();
    return { answered: true, answer };
  }

  private async progress(jobId: string, args: Record<string, unknown>) {
    const job = this.options.store.get(jobId);
    if (!job || finalJobStates.has(job.state)) throw new Error('This helper is finished.');
    if (typeof args.note !== 'string') throw new Error('note is required.');
    await this.options.store.update(jobId, { progress: clip(args.note.trim(), 500) });
    this.changed();
    return { recorded: true };
  }

  // ---- lifecycle ----

  /** Start queued helpers. A request that arrives mid-pass runs another pass, so none is lost. */
  private dispatch(): Promise<void> {
    if (this.disposed) return this.dispatchRun;
    this.dispatchAgain = true;
    if (!this.dispatching) this.dispatchRun = this.dispatchLoop();
    return this.dispatchRun;
  }

  private async dispatchLoop(): Promise<void> {
    this.dispatching = true;
    try {
      while (this.dispatchAgain && !this.disposed) {
        this.dispatchAgain = false;
        try { await this.dispatchQueued(); }
        catch (error) { this.options.log?.(`[helpers] dispatch: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally { this.dispatching = false; }
  }

  private async dispatchQueued(): Promise<void> {
    {
      for (const listed of this.list().filter(item => item.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        // Each job is judged on its current state, and one job's trouble never stops the rest.
        const job = this.options.store.get(listed.id);
        if (!job || job.state !== 'queued') continue;
        try {
          const dependencies = job.dependsOn.map(id => this.options.store.get(id));
          const broken = dependencies.find(dependency => !dependency || dependency.state === 'failed' || dependency.state === 'cancelled');
          if (broken) { await this.options.store.transition(job.id, 'failed', `A job it depends on did not finish (${broken?.id ?? 'missing'}).`); this.changed(); continue; }
          if (dependencies.some(dependency => dependency!.state !== 'done')) continue;
          if (this.disposed || this.active.size >= Math.max(1, this.options.maxConcurrent())) continue;
          await this.launch(job);
        } catch (error) { this.options.log?.(`[helpers] ${job.id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }

  private async launch(job: Job): Promise<void> {
    await this.options.store.transition(job.id, 'starting');
    this.changed();
    let token: string | undefined;
    try {
      const executable = await this.options.executable(job.provider);
      const created = await createWorktree(this.options.leadFolder, job.title, job.id, this.options.worktreeRoot?.(), job.baseCommit);
      await this.options.store.update(job.id, { worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit });
      token = this.options.endpoint.issue({ role: 'helper', leadKey: this.options.leadKey, jobId: job.id });
      // The time limit counts from here, before the job is visible as running.
      const startedAt = this.now();
      await this.options.store.transition(job.id, 'running');
      const run = this.options.startRun({
        provider: job.provider, executable, worktree: created.worktree, model: job.model,
        prompt: helperPrompt({ ...job, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit }),
        maxTurns: job.limits.maxTurns, maxBudgetUsd: job.limits.maxBudgetUsd,
        bridge: { command: this.options.bridge.command, args: this.options.bridge.args, env: { ...(this.options.bridge.env || {}), HYDRA_HELPER_PORT: String(this.options.endpoint.port), HYDRA_HELPER_TOKEN: token } },
        logFile: path.join(this.options.logDirectory, `${job.id}.jsonl`),
        spawned: pid => { this.helperPids.add(pid); },
      });
      const active: Active = { run, token, startedAt, blockedTotal: 0 };
      this.active.set(job.id, active);
      run.onTurnEnd(() => { void this.turnEnded(job.id); });
      void run.exited.then(({ code }) => this.exited(job.id, code));
      // A cancel (or Stop all) can land while the launch is still writing its state: the job
      // then reads as running but had no process to stop. Honour it now.
      if (finalJobStates.has(this.options.store.get(job.id)?.state ?? 'failed')) { void this.stopRun(job.id); return; }
      this.options.log?.(`[helpers] ${job.id} started (${job.provider}) in ${created.worktree}`);
    } catch (error) {
      if (token) this.options.endpoint.revokeJob(job.id);
      await this.active.get(job.id)?.run.stop().catch(() => undefined);
      this.active.delete(job.id);
      await this.options.store.transition(job.id, 'failed', `Could not start: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    }
    this.changed();
  }

  /** The helper finished a turn. If it hasn't reported, nudge it once; then fail it. */
  private async turnEnded(id: string): Promise<void> {
    const job = this.options.store.get(id), active = this.active.get(id);
    if (!job || !active) return;
    if (finalJobStates.has(job.state)) { await this.stopRun(id); return; }
    if (job.state !== 'running') return;
    if (!job.nudged) {
      await this.options.store.update(id, { nudged: true });
      const sent = await active.run.send('You stopped without reporting to Hydra. Commit your work and call hydra_done with a summary, or call hydra_stuck with one clear question. Do it now.');
      if (sent) return;
    }
    await this.finish(id, 'failed', 'The helper stopped without calling hydra_done or hydra_stuck.');
  }

  private async exited(id: string, code: number | null): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    active.answer?.(undefined as unknown as string);
    this.active.delete(id);
    this.options.endpoint.revokeJob(id);
    const job = this.options.store.get(id);
    if (job && !finalJobStates.has(job.state)) {
      await this.options.store.transition(id, 'failed', `The helper process exited${code === null ? '' : ` (code ${code})`} without finishing.`).catch(() => undefined);
    }
    this.changed();
    void this.dispatch();
  }

  private async enforceLimits(): Promise<void> {
    for (const [id, active] of this.active) {
      const job = this.options.store.get(id);
      if (!job || finalJobStates.has(job.state)) continue;
      const blocked = active.blockedTotal + (active.blockedSince !== undefined ? this.now() - active.blockedSince : 0);
      if (this.now() - active.startedAt - blocked > job.limits.wallClockMs) {
        await this.finish(id, 'failed', `Time limit reached (${Math.round(job.limits.wallClockMs / 60000)} minutes of work).`).catch(() => undefined);
      }
    }
  }

  /** Stop a running helper and settle its job. */
  private async finish(id: string, to: 'failed' | 'cancelled', reason: string): Promise<void> {
    const active = this.active.get(id);
    const job = this.options.store.get(id);
    if (job && !finalJobStates.has(job.state)) await this.options.store.transition(id, to, reason);
    active?.answer?.(undefined as unknown as string);
    this.changed();
    await this.stopRun(id);
  }

  private async stopRun(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.options.endpoint.revokeJob(id);
    await active.run.stop().catch(() => undefined);
  }

  private async runChecks(job: Job, attempt: number): Promise<JobCheckResult[]> {
    const checks = await loadHelperChecks(this.options.leadFolder);
    const results: JobCheckResult[] = [];
    for (const check of checks) {
      const logFile = path.join(this.options.logDirectory, `${job.id}-check-${attempt}-${check.id}.log`);
      const started = this.now();
      const outcome = await runCheckCommand({ executable: check.command[0]!, args: check.command.slice(1) }, job.worktree!, logFile, undefined, undefined, 3000, check.timeoutSeconds * 1000, undefined, pid => { this.helperPids.add(pid); });
      const output = await readFile(logFile, 'utf8').catch(() => '');
      results.push({ id: check.id, required: check.required, passed: outcome.exitCode === 0 && !outcome.timedOut, exitCode: outcome.exitCode, durationMs: this.now() - started, outputTail: output.slice(-maxChecksOutput) });
    }
    return results;
  }

  private ownJob(id: unknown): Job {
    if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new Error('job_id must be a helper job id.');
    const job = this.options.store.get(id);
    if (!job || job.leadKey !== this.options.leadKey) throw new Error(`No helper ${id} in this window.`);
    return job;
  }

  private describe(job: Job, detail: boolean) {
    return {
      job_id: job.id, title: job.title, state: job.state, provider: job.provider,
      ...(job.branch ? { branch: job.branch } : {}), ...(job.worktree ? { worktree: job.worktree } : {}), ...(job.baseCommit ? { base_commit: job.baseCommit } : {}),
      ...(job.progress ? { progress: job.progress } : {}), ...(job.question && job.state === 'blocked' ? { question: job.question } : {}),
      ...(job.reason && job.state !== 'running' ? { reason: job.reason } : {}),
      ...(job.result ? { summary: job.result.summary, commit: job.result.commit, ...(detail ? { changed_files: job.result.changedFiles, checks: job.result.checks.map(check => ({ id: check.id, passed: check.passed, required: check.required, ...(check.passed ? {} : { output_tail: check.outputTail }) })) } : {}) } : {}),
      ...(detail ? { write_scope: job.writeScope, attempts: job.attempts } : {}),
    };
  }

  private changed(): void {
    for (const wake of [...this.waiters]) wake();
    this.options.onChange?.();
  }
}

/** Commit everything in a helper's worktree, with the repository's identity or, if it has none, Hydra's. */
async function commitAll(worktree: string, message: string): Promise<void> {
  await git(worktree, ['add', '-A']);
  try { await git(worktree, ['commit', '-q', '-m', message]); }
  catch (error) {
    if (!/tell me who you are|user\.email|user\.name|empty ident/i.test(String(error))) throw error;
    await git(worktree, ['-c', 'user.name=Hydra helper', '-c', 'user.email=helper@hydra.invalid', 'commit', '-q', '-m', message]);
  }
}

export function inScope(file: string, scope: string[]): boolean {
  const normalized = file.replace(/\\/g, '/');
  return scope.some(entry => {
    if (entry === '') return true;
    const prefix = entry.replace(/\/+$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

/** Checks come from the lead's folder, never the helper's worktree, so a helper can't edit them away. */
export async function loadHelperChecks(folder: string): Promise<HelperCheck[]> {
  let raw: string;
  try { raw = await readFile(path.join(folder, '.hydra', 'checks.json'), 'utf8'); } catch { return []; }
  const parsed = JSON.parse(raw) as { checks?: unknown };
  if (!Array.isArray(parsed.checks) || parsed.checks.length > 20) throw new Error('.hydra/checks.json must have a "checks" list of up to 20 entries.');
  return parsed.checks.map((value, index) => {
    const check = value as Record<string, unknown>;
    const command = check.command;
    if (!Array.isArray(command) || command.length < 1 || command.some(part => typeof part !== 'string' || !part)) throw new Error(`.hydra/checks.json check ${index + 1}: "command" must be a list like ["npm", "test"].`);
    const id = typeof check.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(check.id) ? check.id : `check-${index + 1}`;
    const timeoutSeconds = typeof check.timeoutSeconds === 'number' ? Math.max(1, Math.min(900, check.timeoutSeconds)) : 600;
    return { id, command: command as string[], timeoutSeconds, required: check.required !== false };
  });
}

export function helperPrompt(job: Pick<Job, 'id' | 'title' | 'brief' | 'writeScope' | 'worktree' | 'branch' | 'baseCommit'>): string {
  return [
    `You are a Hydra helper (job ${job.id}): ${job.title}`,
    '',
    job.brief,
    '',
    'How to work:',
    `- Work only in this git worktree: ${job.worktree}, on branch ${job.branch}. It starts from commit ${job.baseCommit}.`,
    `- You may change only these paths: ${job.writeScope.length ? job.writeScope.map(entry => entry || '(whole repository)').join(', ') : '(whole repository)'}. Changes elsewhere are refused.`,
    '- Nobody will approve anything for you. Tools you are not allowed to use are denied; work around them.',
    '- When you are finished, call the hydra_done tool with a summary. Hydra commits any uncommitted changes for you (you may also commit yourself), checks the changes, and tells you if anything must be fixed.',
    '- If you cannot continue without a decision, call hydra_stuck with one clear question. The answer comes back as the tool result.',
    '- Never stop without calling hydra_done or hydra_stuck.',
  ].join('\n');
}
