import { spawn, execFile } from 'node:child_process';
import path from 'node:path';

export interface ProbeOutput {
  args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string;
}
export function processLaunch(executable: string, args: string[]): { executable: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${[executable, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`;
    return { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  return { executable, args };
}
export function checkWindowsTermination(pid: number, error: (Error & { code?: string | number | null }) | null, probe: (pid: number, signal: 0) => unknown = process.kill): void {
  if (!error) return;
  // taskkill starts asynchronously: an owned process can exit after our alive
  // check. Only its not-found result plus an independent absence check is safe
  // to ignore; permission failures must still reach the caller.
  if (error.code === 128) {
    try { probe(pid, 0); }
    catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') return; }
  }
  throw error;
}
export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
      try { checkWindowsTermination(pid, error); resolve(); }
      catch (failure) { reject(failure); }
    }));
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
// Public help/version probes only. Arguments are never interpreted by a command shell.
export function runProbe(executable: string, args: string[], cwd: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<ProbeOutput> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: string | undefined, settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(fallback);
      options.signal?.removeEventListener('abort', abort);
      resolve({ args, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, error: failure });
    };
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      if (child.pid) void terminateProcessTree(child.pid).catch(error => { failure += ` Process cleanup failed: ${String(error)}`; child.kill(); });
      fallback = setTimeout(() => finish(null), 3000);
    };
    const abort = () => stop('Provider check cancelled.');
    const timer = setTimeout(() => stop('Provider check timed out.'), options.timeoutMs ?? 8000);
    const collect = (target: Buffer[], data: Buffer) => {
      const remaining = (options.maxBytes ?? 256 * 1024) - bytes;
      if (remaining > 0) { target.push(data.subarray(0, remaining)); bytes += Math.min(remaining, data.length); }
      if (data.length > remaining) stop('Provider check exceeded its output limit.');
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    child.on('error', error => { failure = error.message; finish(null); });
    child.on('close', code => finish(code));
    child.stdin.end();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
