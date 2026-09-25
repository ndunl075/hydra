import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobCheckResult } from '../jobs';
import type { CommandGate } from './config';
import type { GateRun } from './types';

/**
 * The command gate: today's head check, moved here unchanged (docs/Gates_Plan.md).
 * It runs in the worktree with its timeout, keeps the output's tail, and saves the
 * whole log. The one addition: on Windows a bare name like "npm" is looked up on
 * PATH with its extension (npm.cmd), which a direct spawn can't find by itself.
 */
export const maxCommandOutput = 2000;

/**
 * On Windows, a bare command name resolved against PATH and PATHEXT, so
 * ["npm", "test"] finds npm.cmd (which processLaunch then runs through
 * PowerShell). Anything with a path or an extension, and every other platform,
 * is left as it is.
 */
export async function resolveCommand(executable: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (platform !== 'win32' || /[\\/]/.test(executable)) return executable;
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(extension => extension.trim().toLowerCase()).filter(Boolean);
  if (extensions.includes(path.extname(executable).toLowerCase())) return executable;
  for (const directory of (env.PATH || '').split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try { await access(candidate); return candidate; } catch { /* keep looking */ }
    }
  }
  return executable;
}

export async function runCommandGate(gate: CommandGate, run: GateRun): Promise<JobCheckResult> {
  const logFile = path.join(run.logDirectory, `${gate.id}.log`);
  const started = run.runtime.now();
  const executable = await resolveCommand(gate.command[0]!);
  const outcome = await run.runtime.runCommand({ executable, args: gate.command.slice(1), ...(gate.env ? { env: gate.env } : {}) }, run.worktree, logFile, gate.timeoutSeconds * 1000, run.signal, run.spawned);
  const output = await readFile(logFile, 'utf8').catch(() => '');
  const passed = outcome.exitCode === 0 && !outcome.timedOut && !outcome.interrupted;
  const summary = passed ? undefined
    : outcome.timedOut ? `Timed out after ${gate.timeoutSeconds} s.`
    : outcome.interrupted ? 'Stopped before it finished.'
    : outcome.unavailable ? `${gate.command[0]} wasn't found.`
    : `Exited with code ${outcome.exitCode ?? 'none'}.`;
  return {
    id: gate.id, kind: 'command', required: gate.required, state: passed ? 'passed' : 'failed', passed,
    exitCode: outcome.exitCode, durationMs: run.runtime.now() - started, outputTail: output.slice(-maxCommandOutput),
    evidence: [logFile], ...(summary ? { summary } : {}),
  };
}
