import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Task } from './model';
import type { DelegatedVerificationEvidence, VerificationCheckEvidence, VerificationCommand } from './delegationEvidence';
import { validateDelegatedVerificationEvidence } from './delegationEvidence';
import { parseIntegrationCommands, type IntegrationCommand } from './integrationModel';
import { git } from './worktrees';
import { processLaunch, terminateProcessTree } from './process';

export interface DelegatedVerificationCheck { id: string; required: boolean; timeoutMs: number; command: IntegrationCommand }
export interface DelegatedVerificationRun { task: Pick<Task, 'id' | 'worktree' | 'delegation' | 'reviewedCommit' | 'verificationEvidence'>; checks: DelegatedVerificationCheck[]; signal?: AbortSignal }
export interface DelegatedVerificationCommandResult { exitCode: number | null; unavailable: boolean; interrupted: boolean; timedOut: boolean; logFailed: boolean; logged: boolean }
const checkId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/i.test(value);
const taskId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const now = () => new Date().toISOString();
const artifact = (task: string, attempt: string, check: string) => `delegation-evidence/${task}/${attempt}/${check}.log`;

export function parseDelegatedVerificationChecks(value: unknown): DelegatedVerificationCheck[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('Choose between one and 32 explicit delegated verification checks.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid delegated verification check.');
    const candidate = item as { id?: unknown; required?: unknown; timeoutMs?: unknown; command?: unknown };
    if (!checkId(candidate.id) || ids.has(candidate.id) || typeof candidate.required !== 'boolean' || !Number.isSafeInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) < 1000 || (candidate.timeoutMs as number) > 900000) throw new Error('Delegated verification checks require unique bounded IDs, an explicit required flag, and a 1 second to 15 minute timeout.');
    ids.add(candidate.id); const [command] = parseIntegrationCommands([candidate.command]);
    return { id: candidate.id, required: candidate.required, timeoutMs: candidate.timeoutMs as number, command: { executable: command!.executable, args: [...command!.args] } };
  });
}
async function receipt(task: DelegatedVerificationRun['task']): Promise<{ commit: string; tree: string }> {
  if (!task.delegation || !task.reviewedCommit) throw new Error('A reviewed delegated child is required before verification.');
  const commit = (await git(task.worktree, ['rev-parse', 'HEAD'])).trim(); const tree = (await git(task.worktree, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (commit !== task.reviewedCommit.commit || tree !== task.reviewedCommit.tree) throw new Error('Task no longer matches its reviewed commit. Prepare a fresh review.');
  if (await git(task.worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) throw new Error('Delegated verification requires a clean saved child worktree.');
  return { commit, tree };
}
/** Runs one owned command. Abort settlement is bounded even when OS tree cleanup fails. */
export async function runDelegatedVerificationCommand(command: VerificationCommand, cwd: string, filename: string, signal?: AbortSignal, terminate: (pid: number) => Promise<void> = terminateProcessTree, abortGraceMs = 3000, timeoutMs = 300000, openLog: typeof open = open): Promise<DelegatedVerificationCommandResult> {
  if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 1 || abortGraceMs > 30000) throw new Error('Invalid delegated verification abort grace period.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Invalid delegated verification command timeout.');
  if (signal?.aborted) return { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: false };
  await mkdir(path.dirname(filename), { recursive: true }); const handle = await openLog(filename, 'wx');
  if (signal?.aborted) { await handle.close(); return { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: false }; }
  return new Promise((resolve, reject) => {
    const launch = processLaunch(command.executable, command.args); const child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false, unavailable = false, interrupted = false, timedOut = false, writeError: unknown, cleanup: Promise<void> | undefined, fallback: ReturnType<typeof setTimeout> | undefined, timer: ReturnType<typeof setTimeout> | undefined, writes = Promise.resolve();
    let stop!: (reason: string, options?: { interrupted?: boolean; timedOut?: boolean }) => void;
    const append = (data: string | Buffer) => { if (settled) return; writes = writes.then(async () => { if (writeError) return; if (typeof data === 'string') await handle.write(data); else await handle.write(data); }).catch(error => { if (!writeError) { writeError = error; stop('Hydra could not retain verification output; the owned runner was stopped.'); } }); };
    stop = (reason, options = {}) => {
      if (cleanup || settled) return;
      interrupted ||= options.interrupted === true; timedOut ||= options.timedOut === true;
      append(`${reason}\n`);
      // Start this before asking the OS to clean up. `taskkill` is normally
      // bounded, but shutdown cannot trust any external process to settle.
      fallback = setTimeout(() => {
        append(`Hydra process-tree cleanup exceeded ${abortGraceMs}ms; verification remains interrupted and writer ownership is uncertain.\n`);
        // The tree operation may be stuck, but make one bounded best-effort to
        // release the direct owned handle before closing the retained log.
        child.kill();
        void finish(null, false);
      }, abortGraceMs);
      cleanup = child.pid ? terminate(child.pid).catch(error => {
        append(`Hydra could not confirm process-tree termination: ${error instanceof Error ? error.message : String(error)}\n`);
        // A direct owned child may still be terminable after a Windows tree
        // cleanup denial. Either way, the bounded fallback records interruption.
        child.kill();
      }) : Promise.resolve();
    };
    const abort = () => stop('Hydra verification cancelled.', { interrupted: true });
    const finish = async (exitCode: number | null, awaitCleanup = true) => { if (settled) return; settled = true; clearTimeout(fallback); clearTimeout(timer); signal?.removeEventListener('abort', abort); try { if (awaitCleanup) await cleanup; await writes; await handle.close(); resolve({ exitCode, unavailable, interrupted, timedOut, logFailed: Boolean(writeError), logged: !writeError }); } catch (error) { await handle.close().catch(() => {}); reject(new Error(`Delegated verification runner could not settle: ${error instanceof Error ? error.message : String(error)}`)); } };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT'; append(`${error.name}: ${error.message}\n`); void finish(null, !interrupted); }); child.on('close', code => void finish(code, !interrupted));
    timer = setTimeout(() => stop(`Hydra verification command timed out after ${timeoutMs}ms.`, { timedOut: true }), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
function toCheck(input: DelegatedVerificationCheck, result: DelegatedVerificationCommandResult, startedAt: string, finishedAt: string, log: string): VerificationCheckEvidence {
  const artifacts = result.logged ? [{ kind: 'log' as const, path: log, label: `${input.id} full command output` }] : [];
  if (result.unavailable) return { id: input.id, required: input.required, status: 'unavailable', finishedAt, artifacts };
  const command = { executable: input.command.executable, args: [...input.command.args] };
  return { id: input.id, required: input.required, status: result.interrupted ? 'interrupted' : result.timedOut || result.logFailed ? 'failed' : result.exitCode === 0 ? 'passed' : 'failed', command, startedAt, finishedAt, exitCode: result.interrupted || result.timedOut || result.logFailed ? null : result.exitCode, artifacts };
}
export async function recordDelegatedVerification(storageDirectory: string, input: DelegatedVerificationRun): Promise<DelegatedVerificationEvidence> {
  const checks = parseDelegatedVerificationChecks(input.checks); if (!taskId(input.task.id)) throw new Error('Delegated verification requires a canonical Hydra task ID before artifact paths are created.');
  const prior = input.task.verificationEvidence ? structuredClone(input.task.verificationEvidence) : undefined; if (prior) validateDelegatedVerificationEvidence(prior);
  const checked = await receipt(input.task);
  // Version 1 retains one immutable reviewed-result history.  A later reviewed
  // result needs an explicit future boundary/archive record; replacing this
  // field would silently erase evidence for the earlier result.
  if (prior && (prior.attempts[0]!.checkedCommit !== checked.commit || prior.attempts[0]!.checkedTree !== checked.tree)) throw new Error('Delegated verification evidence belongs to an earlier reviewed result. Preserve it and create an explicit new-result boundary before recording more checks.');
  const previous = prior;
  if (previous && previous.attempts.length >= 2) throw new Error('Delegated verification retry limit reached. Create a new reviewed child result before another attempt.');
  for (const required of previous?.attempts.flatMap(attempt => attempt.checks).filter(check => check.required) || []) if (!checks.some(check => check.id === required.id && check.required)) throw new Error(`Delegated verification retry omitted previously required check: ${required.id}.`);
  const id = randomBytes(12).toString('hex'), startedAt = now(), recorded: VerificationCheckEvidence[] = [];
  for (const check of checks) { const checkStartedAt = now(), log = artifact(input.task.id, id, check.id); const result = await runDelegatedVerificationCommand(check.command, input.task.worktree, path.join(storageDirectory, ...log.split('/')), input.signal, terminateProcessTree, 3000, check.timeoutMs); recorded.push(toCheck(check, result, checkStartedAt, now(), log)); if (result.interrupted || result.timedOut) break; }
  for (const check of checks.slice(recorded.length)) recorded.push({ id: check.id, required: check.required, status: 'interrupted', command: { executable: check.command.executable, args: [...check.command.args] }, finishedAt: now(), exitCode: null, artifacts: [] });
  await receipt(input.task).catch(() => { for (const check of recorded) if (check.status === 'passed') { check.status = 'failed'; check.exitCode = null; } });
  const evidence: DelegatedVerificationEvidence = { version: 1, attempts: [...(previous?.attempts || []), { id, number: (previous?.attempts.length || 0) + 1, checkedCommit: checked.commit, checkedTree: checked.tree, startedAt, finishedAt: now(), findings: [], checks: recorded }] };
  validateDelegatedVerificationEvidence(evidence); return evidence;
}
