import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
/**
 * Every call also passes `-c core.fsmonitor=false` (1.4, docs/Hydra_Improvements.md): worktrees
 * of one repository share a single `.git`, so a head or a lane could set `core.fsmonitor` in it to
 * a command of its choosing. Without this override that command would run the next time Hydra (or
 * the user) runs git anywhere in the repository, including the main checkout. `core.quotepath=false`
 * is unrelated (it keeps non-ASCII paths readable); both are passed on every call from this module.
 */
const gitFlags = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];
export async function gitBytes(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<Buffer> {
  try {
    const { stdout } = await execute('git', [...gitFlags, ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
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
    execFile('git', [...gitFlags, ...args], { cwd, env: { ...process.env, ...environment }, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: unknown }) | null)?.code;
      if (error && typeof code !== 'number') return reject(new Error((error as Error & { killed?: boolean }).killed ? `git ${args[0]} took too long.` : stderr.trim() || error.message));
      resolve({ code: error ? code as number : 0, stdout, stderr });
    });
  });
}

/**
 * A fingerprint of the git metadata a worktree shares with every other worktree of the same
 * repository (1.4, docs/Hydra_Improvements.md): `config`, `config.worktree` (if present),
 * `info/attributes` (if present) and every file under `hooks/` except `*.sample`, each hashed by
 * name so a change can be named. A head that edits `.git/config` or `.git/hooks/*` runs code the
 * next time Hydra or the user runs git anywhere in the repository, including the main checkout;
 * comparing this fingerprint at `hydra_done` and at a lane's Merge (or Mark job done) catches it.
 * Only present files are included, so a missing file never shows up as a spurious change.
 */
export type GitMetaFingerprint = Readonly<Record<string, string>>;

async function commonGitDir(repository: string): Promise<string> {
  const raw = (await git(repository, ['rev-parse', '--git-common-dir'])).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repository, raw);
}

export async function gitMetaFingerprint(repository: string): Promise<GitMetaFingerprint> {
  const dir = await commonGitDir(repository);
  const fingerprint: Record<string, string> = {};
  const hashFile = async (relative: string, absolute: string): Promise<void> => {
    let data: Buffer;
    try { data = await readFile(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    fingerprint[relative] = createHash('sha256').update(data).digest('hex');
  };
  await hashFile('config', path.join(dir, 'config'));
  await hashFile('config.worktree', path.join(dir, 'config.worktree'));
  await hashFile('info/attributes', path.join(dir, 'info', 'attributes'));
  let hooks: string[] = [];
  try { hooks = (await readdir(path.join(dir, 'hooks'))).filter(name => !name.endsWith('.sample')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of hooks) await hashFile(`hooks/${name}`, path.join(dir, 'hooks', name));
  return fingerprint;
}

/** The files that differ between two fingerprints (added, removed or changed contents), sorted by name. Empty means nothing changed. */
export function gitMetaChanges(before: GitMetaFingerprint, after: GitMetaFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => before[name] !== after[name]).sort();
}
