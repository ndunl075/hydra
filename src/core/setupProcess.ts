import { spawn } from 'node:child_process';
import { processLaunch, terminateProcessTree } from './process';
import type { IntegrationCommand } from './integrationModel';
export interface SetupOutput { stdout: string; stderr: string; exitCode: number | null; error?: string; uncertain?: boolean }
/** Explicit user-selected command. Terminate only its owned process tree. */
export function runSetupCommand(command: IntegrationCommand, cwd: string, environment: Record<string, string>, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<SetupOutput> {
  if (signal.aborted) return Promise.resolve({ stdout: '', stderr: '', exitCode: null, error: 'Setup cancelled before command launch.' });
  return new Promise(resolve => {
    const launch = processLaunch(command.executable, command.args);
    const child = spawn(launch.executable, launch.args, { cwd, env: { ...process.env, ...environment }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, error: string | undefined, uncertain = false, finished = false;
    let cleanup: Promise<void> = Promise.resolve(), fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = async (exitCode: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(fallback); signal.removeEventListener('abort', abort);
      await cleanup;
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, ...(error ? { error } : {}), ...(uncertain ? { uncertain } : {}) });
    };
    const stop = (reason: string) => {
      if (error || finished) return; error = reason;
      if (child.pid && child.exitCode === null && child.signalCode === null) cleanup = terminateProcessTree(child.pid).catch(failure => { uncertain = true; error += ` Owned cleanup failed: ${String(failure)}`; });
      else if (child.pid) uncertain = true; // Exited parent with still-open pipes: never target a potentially reused PID.
      fallback = setTimeout(() => { uncertain = true; void finish(null); }, 3000);
    };
    const abort = () => stop('Setup cancelled.');
    const timer = setTimeout(() => stop('Setup command timed out.'), timeoutMs);
    const collect = (target: Buffer[], data: Buffer) => {
      const remaining = Math.max(0, maxBytes - bytes); if (remaining) target.push(data.subarray(0, remaining)); bytes += Math.min(remaining, data.length);
      if (data.length > remaining) stop('Setup exceeded its output limit.');
    };
    child.stdout.on('data', data => collect(stdout, data)); child.stderr.on('data', data => collect(stderr, data));
    child.on('error', failure => { error = failure.message; void finish(null); }); child.on('close', code => { void finish(code); });
    child.stdin.on('error', failure => stop(failure.message)); child.stdin.end();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
