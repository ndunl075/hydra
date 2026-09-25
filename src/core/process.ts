import { spawn, execFile } from 'node:child_process';
import path from 'node:path';

export interface ProbeOutput {
  args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string;
  /** Stopped because it ran past `timeoutMs`. */
  timedOut?: boolean;
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
export function checkWindowsTermination(pid: number, error: (Error & { code?: string | number | null }) | null, probe: (pid: number, signal: 0) => unknown = process.kill, stderr = '', stdout = ''): void {
  if (!error) return;
  // A descendant can exit while taskkill walks the owned tree. Accept only
  // complete not-found diagnostics, then independently check every named PID.
  // Unknown/localized diagnostics and mixed permission failures fail closed.
  const absent = new Set([pid]);
  let diagnostic = stderr.trim();
  if (diagnostic && (error.code === 1 || error.code === 128 || error.code === 255)) {
    diagnostic = diagnostic.replace(/ERROR: The process with PID (\d+)(?: \(child process of PID (\d+)\))? could not be terminated\.\s*Reason: There is no running instance of the task\./g, (_match, child: string, parent?: string) => {
      absent.add(Number(child)); if (parent && Number(child) !== pid) absent.add(Number(parent)); return '';
    }).replace(/ERROR: The process "(\d+)" not found\./g, (_match, missing: string) => { absent.add(Number(missing)); return ''; }).trim();
  } else if (error.code !== 128) throw error;
  if (diagnostic) throw error;
  // Successful records can name other descendants; their parent can be the
  // live extension host, so check only the PID actually reported terminated.
  const remainder = stdout.trim().replace(/SUCCESS: The process with PID (\d+)(?: \(child process of PID \d+\))? has been terminated\./g, (_match, terminated: string) => { absent.add(Number(terminated)); return ''; }).trim();
  if (remainder) throw error;
  for (const target of absent) {
    if (!Number.isSafeInteger(target) || target <= 0) throw error;
    try { probe(target, 0); }
    catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') continue; }
    throw error;
  }
}
export async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      try { checkWindowsTermination(pid, error, process.kill, stderr, stdout); resolve(); }
      catch (failure) { reject(failure); }
    }));
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
/**
 * Run a CLI once and collect its output: help/version probes, the planner, and a
 * review gate. Arguments are never interpreted by a command shell. `input` is
 * written to stdin (a review's prompt is too long for a command line), and
 * `spawned` hears the process id, so Hydra can refuse it as a lead.
 */
export function runProbe(executable: string, args: string[], cwd: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; input?: string; spawned?: (pid: number) => void } = {}): Promise<ProbeOutput> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) options.spawned?.(child.pid);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: string | undefined, settled = false, timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(fallback);
      options.signal?.removeEventListener('abort', abort);
      resolve({ args, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, error: failure, ...(timedOut ? { timedOut } : {}) });
    };
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      if (child.pid) void terminateProcessTree(child.pid).catch(error => { failure += ` Process cleanup failed: ${String(error)}`; child.kill(); });
      fallback = setTimeout(() => finish(null), 3000);
    };
    const abort = () => stop('Provider check cancelled.');
    const timer = setTimeout(() => { timedOut = true; stop('Provider check timed out.'); }, options.timeoutMs ?? 8000);
    const collect = (target: Buffer[], data: Buffer) => {
      const remaining = (options.maxBytes ?? 256 * 1024) - bytes;
      if (remaining > 0) { target.push(data.subarray(0, remaining)); bytes += Math.min(remaining, data.length); }
      if (data.length > remaining) stop('Provider check exceeded its output limit.');
    };
    child.stdout.on('data', data => collect(stdout, data));
    child.stderr.on('data', data => collect(stderr, data));
    child.on('error', error => { failure = error.message; finish(null); });
    child.on('close', code => finish(code));
    // A CLI that exits before reading all of its input closes the pipe; that is its answer, not a crash.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
