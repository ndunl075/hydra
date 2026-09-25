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
/** Where Hydra puts worktrees when hydra.worktreeRoot is empty: a sibling `<repository>.worktrees` folder. */
export const defaultWorktreeRoot = (repository: string): string => path.join(path.dirname(repository), `${path.basename(repository)}.worktrees`);
/**
 * A head's worktree is `<root>/<id>` on `agent/<slug>-<id>`. A lane passes its own
 * `layout` (`<root>/lane-<id>` on `lane/<slug>-<id>`), built only from a slug and the id.
 */
export async function createWorktree(repository: string, title: string, id: string, configuredRoot?: string, startingCommit?: string, layout?: { branch: string; folder: string }) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid worktree ID.');
  if (layout && (!/^[a-z0-9-]{1,64}$/.test(layout.folder) || !/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(layout.branch) || layout.branch.length > 120)) throw new Error('Invalid worktree layout.');
  repository = await repositoryRoot(repository);
  if (startingCommit && !/^[a-f0-9]{40,64}$/.test(startingCommit)) throw new Error('Starting commit must be a full commit SHA.');
  const baseCommit = (await git(repository, ['rev-parse', '--verify', `${startingCommit || 'HEAD'}^{commit}`])).trim();
  const integrationTarget = (await git(repository, ['symbolic-ref', '--short', 'HEAD'])).trim();
  const root = configuredRoot || defaultWorktreeRoot(repository);
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
  const worktree = path.join(canonicalRoot, layout?.folder ?? id);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
  const branch = layout?.branch ?? `agent/${slug}-${id}`;
  await git(repository, ['worktree', 'add', '-b', branch, worktree, baseCommit]);
  return { worktree, branch, baseCommit, integrationTarget };
}
