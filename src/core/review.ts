import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { git, gitBytes } from './git';
import { isInside } from './worktrees';
import type { DiffLayer, FileChange, TaskFile } from './model';

export const textLimit = 2 * 1024 * 1024;
export interface ReviewContent { kind: 'text' | 'binary' | 'large' | 'submodule' | 'unsupported'; text?: string; bytes: number; mode?: string; oid?: string; absent?: boolean }
export interface ReviewSnapshot { path: string; beforePath?: string; layer: DiffLayer; status: string; left: ReviewContent; right: ReviewContent; head: string; createdAt: string }
const empty = (): ReviewContent => ({ kind: 'text', text: '', bytes: 0, absent: true });

export function parseNameStatus(output: string, layer: DiffLayer): FileChange[] {
  const records = output.split('\0'), result: FileChange[] = [];
  for (let i = 0; i < records.length && records[i];) {
    const status = records[i++]!;
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error('Invalid Git change record.');
    const first = records[i++];
    if (!first) throw new Error('Incomplete Git change record.');
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = records[i++]; if (!target) throw new Error('Incomplete Git rename record.');
      result.push({ layer, status, beforePath: first, path: target });
    } else result.push({ layer, status, path: first });
  }
  return result;
}
export async function reviewChanges(worktree: string, baseCommit: string): Promise<FileChange[]> {
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error('Invalid task base commit.');
  const flags = ['--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none'];
  const results = await Promise.all([
    git(worktree, ['diff', ...flags, baseCommit, '--']),
    git(worktree, ['diff', ...flags, baseCommit, 'HEAD', '--']),
    git(worktree, ['diff', '--cached', ...flags, 'HEAD', '--']),
    git(worktree, ['diff', ...flags, '--']),
    git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  return [...parseNameStatus(results[0]!, 'combined'), ...parseNameStatus(results[1]!, 'committed'), ...parseNameStatus(results[2]!, 'staged'), ...parseNameStatus(results[3]!, 'unstaged'),
    ...results[4]!.split('\0').filter(Boolean).map(name => ({ path: name, status: '??', layer: 'untracked' as const }))];
}
export async function reviewFiles(worktree: string, baseCommit: string): Promise<TaskFile[]> {
  const files = new Map<string, TaskFile>();
  for (const change of await reviewChanges(worktree, baseCommit)) {
    const file = files.get(change.path) || { path: change.path, status: change.status, changes: [] };
    const previous = file.changes!.findIndex(item => item.layer === change.layer);
    if (previous < 0) file.changes!.push(change);
    else if (change.status.startsWith('U')) file.changes![previous] = change;
    if (!file.status.startsWith('U')) file.status = change.status;
    files.set(change.path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
function classify(buffer: Buffer, mode?: string, oid?: string): ReviewContent {
  const metadata = { bytes: buffer.length, mode, oid };
  if (buffer.includes(0)) return { kind: 'binary', ...metadata };
  try { return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), ...metadata }; }
  catch { return { kind: 'unsupported', ...metadata }; }
}
function validatePath(relative: string): void {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Expected a relative task file path.');
}
async function blob(worktree: string, revision: string, relative: string): Promise<ReviewContent> {
  validatePath(relative);
  const output = revision === 'index' ? await git(worktree, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative]) : await git(worktree, ['--literal-pathspecs', 'ls-tree', '-z', revision, '--', relative]);
  const entry = output.split('\0').find(line => line.slice(line.indexOf('\t') + 1) === relative);
  if (!entry) return empty();
  const metadata = entry.slice(0, entry.indexOf('\t')).split(' ');
  const [mode, typeOrOid, oidOrStage] = metadata;
  if (revision === 'index' && oidOrStage !== '0') throw new Error('This file has merge conflicts. Resolve them in native Source Control before reviewing it.');
  const oid = revision === 'index' ? typeOrOid : oidOrStage;
  if (!oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git object identity.');
  if (mode === '160000') return { kind: 'submodule', mode, oid, bytes: 0 };
  if (!['100644', '100755', '120000'].includes(mode || '')) return { kind: 'unsupported', mode, oid, bytes: 0 };
  const bytes = Number((await git(worktree, ['cat-file', '-s', oid])).trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid Git object size.');
  if (bytes > textLimit) return { kind: 'large', mode, oid, bytes };
  return classify(await gitBytes(worktree, ['cat-file', 'blob', oid]), mode, oid);
}
async function savedFile(worktree: string, relative: string): Promise<ReviewContent> {
  validatePath(relative);
  const root = await realpath(worktree), file = path.resolve(root, relative);
  if (!isInside(root, file)) throw new Error('Review path escapes the task worktree.');
  // Missing files are legitimate deletion sides. Verify every existing parent before reading.
  let parent = path.dirname(file);
  while (true) {
    try { if (!isInside(root, await realpath(parent))) throw new Error('Review parent escapes the task worktree.'); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; parent = path.dirname(parent); }
  }
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
  if (stat.isSymbolicLink()) return classify(Buffer.from(await readlink(file)), '120000'); // Review the link itself; never follow its target.
  if (stat.isDirectory()) return { kind: 'submodule', mode: '160000', bytes: 0 };
  if (!stat.isFile()) return { kind: 'unsupported', bytes: stat.size };
  if (!isInside(root, await realpath(file))) throw new Error('Review file escapes the task worktree.');
  const mode = process.platform === 'win32' || !(stat.mode & 0o111) ? '100644' : '100755';
  if (stat.size > textLimit) return { kind: 'large', mode, bytes: stat.size };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(textLimit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > textLimit) return { kind: 'large', mode, bytes: bytesRead };
    return classify(buffer.subarray(0, bytesRead), mode);
  } finally { await handle.close(); }
}
export async function captureReview(worktree: string, baseCommit: string, relative: string, layer: DiffLayer): Promise<ReviewSnapshot> {
  validatePath(relative);
  const change = (await reviewChanges(worktree, baseCommit)).find(item => item.path === relative && item.layer === layer);
  if (!change) throw new Error('This change is no longer available. Refresh the task inventory.');
  if (change.status.startsWith('U')) throw new Error('Resolve merge conflicts in native Source Control before reviewing this file.');
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const before = change.beforePath || relative;
  const left = layer === 'untracked' ? empty() : await blob(worktree, layer === 'committed' || layer === 'combined' ? baseCommit : layer === 'staged' ? head : 'index', before);
  const right = layer === 'committed' ? await blob(worktree, head, relative) : layer === 'staged' ? await blob(worktree, 'index', relative) : await savedFile(worktree, relative);
  if (['combined', 'unstaged', 'untracked'].includes(layer) && ['100644', '100755'].includes(right.mode || '') && (await git(worktree, ['config', '--get', 'core.filemode']).catch(() => 'true')).trim() === 'false') {
    const index = await git(worktree, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relative]);
    const entry = index.split('\0').find(line => line.slice(line.indexOf('\t') + 1) === relative && line.slice(0, line.indexOf('\t')).endsWith(' 0'));
    if (entry && ['100644', '100755'].includes(entry.slice(0, 6))) right.mode = entry.slice(0, 6);
  }
  const attributes = (await git(worktree, ['--literal-pathspecs', 'check-attr', '-z', 'diff', '--', relative])).split('\0');
  if (attributes[2] === 'unset') for (const side of [left, right]) if (!side.absent && side.kind === 'text') { side.kind = 'binary'; delete side.text; }
  return { ...change, left, right, head, createdAt: new Date().toISOString() };
}
