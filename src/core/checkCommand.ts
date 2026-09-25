import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { processLaunch, terminateProcessTree } from './process';

/**
 * Run one project check command (for example ["npm", "test"]) with a time limit, writing its
 * output to a log and stopping the whole process tree on timeout or abort. Used for
 * Hydra helper checks (docs/Official_Extensions_Plan.md). Extracted from the retired
 * delegated-verification pipeline unchanged.
 */
/** `env` is added to Hydra's own environment (a pack gate's `{node}` sets ELECTRON_RUN_AS_NODE). */
export interface CheckCommand { executable: string; args: string[]; env?: Record<string, string> }
export interface CheckCommandResult { exitCode: number | null; unavailable: boolean; interrupted: boolean; timedOut: boolean; logFailed: boolean; logged: boolean }
export async function runCheckCommand(command: CheckCommand, cwd: string, filename: string, signal?: AbortSignal, terminate: (pid: number) => Promise<void> = terminateProcessTree, abortGraceMs = 3000, timeoutMs = 300000, openLog: typeof open = open, spawned?: (pid: number) => void): Promise<CheckCommandResult> {
  if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 1 || abortGraceMs > 30000) throw new Error('Invalid check abort grace period.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Invalid check timeout.');
  if (signal?.aborted) return { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: false };
  await mkdir(path.dirname(filename), { recursive: true }); const handle = await openLog(filename, 'wx');
  if (signal?.aborted) { await handle.close(); return { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: false }; }
  return new Promise((resolve, reject) => {
    const launch = processLaunch(command.executable, command.args); const child = spawn(launch.executable, launch.args, { cwd, ...(command.env ? { env: { ...process.env, ...command.env } } : {}), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); if (child.pid) spawned?.(child.pid);
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
