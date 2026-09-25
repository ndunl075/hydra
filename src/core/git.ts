import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function gitBytes(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<Buffer> {
  try {
    const { stdout } = await execute('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer };
    throw new Error(failure.stderr?.toString('utf8').trim() || failure.message);
  }
}
export async function git(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> { return (await gitBytes(cwd, args, environment)).toString('utf8'); }
export interface GitResult { code: number; stdout: string; stderr: string }
/**
 * Run git and hand back its exit code and output instead of throwing on a
 * non-zero exit: `merge-tree` and `merge` report conflicts that way. Throws only
 * when git can't run or runs past `timeoutMs`.
 */
export function gitRun(cwd: string, args: string[], environment?: NodeJS.ProcessEnv, timeoutMs = 0): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: unknown }) | null)?.code;
      if (error && typeof code !== 'number') return reject(new Error((error as Error & { killed?: boolean }).killed ? `git ${args[0]} took too long.` : stderr.trim() || error.message));
      resolve({ code: error ? code as number : 0, stdout, stderr });
    });
  });
}
