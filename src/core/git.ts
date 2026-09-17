import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execute('git', ['-c', 'core.quotepath=false', ...args], { cwd, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer };
    throw new Error(failure.stderr?.toString('utf8').trim() || failure.message);
  }
}
export async function git(cwd: string, args: string[]): Promise<string> { return (await gitBytes(cwd, args)).toString('utf8'); }
