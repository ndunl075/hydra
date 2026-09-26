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
 * repository (1.4, docs/Hydra_Improvements.md): the settings in `config` and `config.worktree`
 * that run a program, load more config or redirect git (riskyConfigKey), `info/attributes` (if
 * present) and every file under `hooks/` except `*.sample`, each hashed by name so a change can
 * be named. A head that edits `.git/config` or `.git/hooks/*` runs code the
 * next time Hydra or the user runs git anywhere in the repository, including the main checkout;
 * comparing this fingerprint at `hydra_done` and at a lane's Merge (or Mark job done) catches it.
 * Only present files are included, so a missing file never shows up as a spurious change.
 */
export type GitMetaFingerprint = Readonly<Record<string, string>>;

async function commonGitDir(repository: string): Promise<string> {
  const raw = (await git(repository, ['rev-parse', '--git-common-dir'])).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repository, raw);
}

/**
 * Config settings that make git run a program, load more config, or send work somewhere else.
 * Only these are fingerprinted: everyday git (a push that records branch tracking, a new remote,
 * `gh pr checkout`) rewrites the rest of `.git/config`, and must not look like tampering.
 * Keys are as `git config --list` prints them: section and key lowercased, subsections as written.
 */
const riskyConfigKey = new RegExp([
  String.raw`^core\.(fsmonitor|hookspath|sshcommand|gitproxy|askpass|pager|editor|attributesfile|worktree)$`,
  String.raw`^sequence\.editor$`,
  String.raw`^diff\.external$`, String.raw`^diff\..+\.(command|textconv)$`, String.raw`^difftool\..+\.(cmd|path)$`,
  String.raw`^merge\..+\.driver$`, String.raw`^mergetool\..+\.(cmd|path)$`,
  String.raw`^filter\..+\.(clean|smudge|process)$`,
  String.raw`^credential(\..+)?\.helper$`, String.raw`^gpg(\..+)?\.program$`,
  String.raw`^include\.path$`, String.raw`^includeif\..+\.path$`,
  String.raw`^alias\..+$`,
  String.raw`^url\..+\.(insteadof|pushinsteadof)$`,
  String.raw`^remote\..+\.(pushurl|receivepack|uploadpack|proxy)$`,
  String.raw`^uploadpack\.packobjectshook$`, String.raw`^extensions\.worktreeconfig$`,
].join('|'), 'i');

/** The risky settings in one config file, as `config:<key>` → hash of its values (a key may repeat). */
async function riskyConfig(file: string, into: Record<string, string>, label: string): Promise<void> {
  // `git config --file` reads only that file (no includes), and never runs a hook or fsmonitor.
  const listed = await gitRun(path.dirname(file), ['config', '--file', file, '--list', '--null']).catch(() => undefined);
  if (!listed || listed.code !== 0) return;
  const values = new Map<string, string[]>();
  for (const entry of listed.stdout.split('\0').filter(Boolean)) {
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline), value = newline < 0 ? '' : entry.slice(newline + 1);
    if (!riskyConfigKey.test(key)) continue;
    values.set(key.toLowerCase(), [...values.get(key.toLowerCase()) ?? [], value]);
  }
  for (const [key, list] of values) into[`${label} (${key.slice(0, 200)})`] =createHash('sha256').update(JSON.stringify(list)).digest('hex');
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
  await riskyConfig(path.join(dir, 'config'), fingerprint, 'config');
  await riskyConfig(path.join(dir, 'config.worktree'), fingerprint, 'config.worktree');
  await hashFile('info/attributes', path.join(dir, 'info', 'attributes'));
  let hooks: string[] = [];
  try { hooks = (await readdir(path.join(dir, 'hooks'))).filter(name => !name.endsWith('.sample')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of hooks) await hashFile(`hooks/${name}`, path.join(dir, 'hooks', name));
  // Bounded, so a repository with many aliases or hooks still fits a job or lane record: past the
  // cap, the rest share one entry, which still changes when any of them does.
  const names = Object.keys(fingerprint).sort();
  if (names.length <= gitMetaMaxEntries) return fingerprint;
  const kept: Record<string, string> = {};
  for (const name of names.slice(0, gitMetaMaxEntries - 1)) kept[name] = fingerprint[name]!;
  kept['(other settings and hooks)'] = createHash('sha256').update(JSON.stringify(names.slice(gitMetaMaxEntries - 1).map(name => [name, fingerprint[name]]))).digest('hex');
  return kept;
}
/** At most this many entries in a fingerprint (see gitMetaFingerprint); job and lane records accept this many. */
export const gitMetaMaxEntries = 64;

/** The files that differ between two fingerprints (added, removed or changed contents), sorted by name. Empty means nothing changed. */
export function gitMetaChanges(before: GitMetaFingerprint, after: GitMetaFingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => before[name] !== after[name]).sort();
}
