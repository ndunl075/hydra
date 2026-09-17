import { realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { TaskFile } from './model';
import { git } from './git';
export { git } from './git';
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function resolveTaskFile(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative)) throw new Error('Expected a relative worktree path.');
  const canonicalRoot = await realpath(root);
  const candidate = path.resolve(canonicalRoot, relative);
  if (!isInside(canonicalRoot, candidate)) throw new Error('Path escapes the task worktree.');
  const canonical = await realpath(candidate);
  if (!isInside(canonicalRoot, canonical)) throw new Error('Symlink escapes the task worktree.');
  return canonical;
}
export async function repositoryRoot(folder: string): Promise<string> {
  return realpath((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
}
export async function createWorktree(repository: string, title: string, id: string, configuredRoot?: string) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
  repository = await repositoryRoot(repository);
  const baseCommit = (await git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const integrationTarget = (await git(repository, ['symbolic-ref', '--short', 'HEAD'])).trim();
  const root = configuredRoot || path.join(path.dirname(repository), `${path.basename(repository)}.worktrees`);
  if (!path.isAbsolute(root)) throw new Error('Worktree root must be an absolute path.');
  // Verify the nearest existing ancestor before creating anything, including junctions.
  let ancestor = root;
  let suffix = '';
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix = path.join(path.basename(ancestor), suffix);
      ancestor = parent;
    }
  }
  if (isInside(repository, path.join(ancestor, suffix))) throw new Error('Worktree root must be outside the main repository.');
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  if (isInside(repository, canonicalRoot)) throw new Error('Worktree root must be outside the main repository.');
  const worktree = path.join(canonicalRoot, id);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
  const branch = `agent/${slug}-${id}`;
  await git(repository, ['worktree', 'add', '-b', branch, worktree, baseCommit]);
  return { worktree, branch, baseCommit, integrationTarget };
}
export function parseStatus(output: string): TaskFile[] {
  const records = output.split('\0');
  const files: TaskFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    files.push({ status, path: record.slice(3) });
    if (status.includes('R') || status.includes('C')) i++;
  }
  return files;
}
export async function changedFiles(worktree: string, baseCommit: string): Promise<TaskFile[]> {
  const [committed, status] = await Promise.all([
    git(worktree, ['diff', '--name-status', '-z', '--no-renames', baseCommit, 'HEAD', '--']),
    git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ]);
  const entries = committed.split('\0');
  const files = new Map<string, TaskFile>();
  for (let i = 0; i < entries.length - 1; i += 2) {
    const name = entries[i + 1];
    if (name) files.set(name, { path: name, status: entries[i] || 'M' });
  }
  for (const file of parseStatus(status)) files.set(file.path, file);
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}
