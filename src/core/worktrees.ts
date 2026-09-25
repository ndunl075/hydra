import { realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { git } from './git';
export { git } from './git';
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function repositoryRoot(folder: string): Promise<string> {
  return realpath((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
}
export async function createWorktree(repository: string, title: string, id: string, configuredRoot?: string, startingCommit?: string) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid worktree ID.');
  repository = await repositoryRoot(repository);
  if (startingCommit && !/^[a-f0-9]{40,64}$/.test(startingCommit)) throw new Error('Starting commit must be a full commit SHA.');
  const baseCommit = (await git(repository, ['rev-parse', '--verify', `${startingCommit || 'HEAD'}^{commit}`])).trim();
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
