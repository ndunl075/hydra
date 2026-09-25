import { git, gitRun } from './git';

/**
 * What a head starts from (docs/Gates_Plan.md, section 3).
 *
 * A head that depends on others builds on what they did: its worktree starts
 * from its dependency's result commit, or, with several, from one commit Hydra
 * makes that merges them all. That merge is worked out with `git merge-tree`
 * before any worktree exists, so dependencies that conflict fail the head before
 * it starts, naming the files. The head's brief also says what each dependency
 * did.
 */
export interface DependencyResult { id: string; title: string; summary: string; commit: string; branch?: string; changedFiles: string[] }

export const maxDependencyBrief = 4096;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
/** Hydra's own commits carry Hydra's name, whatever the repository's identity is. */
const hydraIdentity: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Hydra', GIT_AUTHOR_EMAIL: 'heads@hydra.invalid',
  GIT_COMMITTER_NAME: 'Hydra', GIT_COMMITTER_EMAIL: 'heads@hydra.invalid',
};

/** Thrown when the dependencies can't be merged; the head fails with this message. */
export class DependencyConflict extends Error {
  constructor(readonly files: string[]) { super(`The heads it depends on conflict in ${files.join(', ')}; merge them first.`); }
}

/** Two commits merged in memory: the tree, or the files that conflict. Never touches a worktree or the index. */
async function mergeTrees(repository: string, a: string, b: string): Promise<{ tree: string } | { conflicts: string[] }> {
  const result = await gitRun(repository, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b]);
  const [tree, ...files] = result.stdout.split('\0');
  if (result.code === 0 && tree && sha.test(tree)) return { tree };
  if (result.code === 1 && tree && sha.test(tree)) return { conflicts: [...new Set(files.filter(Boolean))] };
  throw new Error(result.stderr.trim() || `git merge-tree exited with ${result.code}.`);
}

/**
 * The commit a dependent head starts from. One dependency (or several where one
 * already contains the others): its result commit. Several: one commit made by
 * Hydra whose parents are all of them. Throws DependencyConflict when they
 * conflict.
 */
export async function dependencyBase(repository: string, title: string, dependencies: readonly DependencyResult[]): Promise<string> {
  const commits = [...new Set(dependencies.map(dependency => dependency.commit))];
  if (!commits.length || commits.some(commit => !sha.test(commit))) throw new Error('A head it depends on has no result commit.');
  // A commit another dependency already contains adds nothing.
  const tips: string[] = [];
  for (const commit of commits) {
    let contained = false;
    for (const other of commits) {
      if (other === commit) continue;
      if ((await gitRun(repository, ['merge-base', '--is-ancestor', commit, other])).code === 0) { contained = true; break; }
    }
    if (!contained) tips.push(commit);
  }
  if (tips.length === 1) return tips[0]!;
  let merged = tips[0]!, tree = '';
  for (const next of tips.slice(1)) {
    const result = await mergeTrees(repository, merged, next);
    if ('conflicts' in result) throw new DependencyConflict(result.conflicts);
    tree = result.tree;
    // A stepping stone so the next merge finds the right merge base; only the final commit is kept.
    merged = (await git(repository, ['commit-tree', tree, '-p', merged, '-p', next, '-m', 'Hydra: merging dependencies'], hydraIdentity)).trim();
  }
  const titles = dependencies.filter(dependency => tips.includes(dependency.commit)).map(dependency => `- ${dependency.title} (${dependency.commit.slice(0, 12)})`);
  const message = `Hydra: merge the heads "${title}" depends on\n\n${titles.join('\n')}`;
  return (await git(repository, ['commit-tree', tree, ...tips.flatMap(tip => ['-p', tip]), '-m', message], hydraIdentity)).trim();
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

/** "What the heads you depend on did:" for the brief: each one's title, summary, branch and changed files, 4 KB in all. */
export function dependencyBrief(dependencies: readonly DependencyResult[]): string {
  const header = 'What the heads you depend on did (your worktree already has their work):';
  const share = Math.floor((maxDependencyBrief - header.length) / Math.max(1, dependencies.length)) - 1;
  const entries = dependencies.map(dependency => {
    const files = dependency.changedFiles.length > 20 ? `${dependency.changedFiles.slice(0, 20).join(', ')} and ${dependency.changedFiles.length - 20} more` : dependency.changedFiles.join(', ');
    return clip([
      `- ${dependency.title}${dependency.branch ? ` (branch ${dependency.branch}, commit ${dependency.commit.slice(0, 12)})` : ` (commit ${dependency.commit.slice(0, 12)})`}: ${dependency.summary.trim()}`,
      ...(files ? [`  Changed files: ${files}`] : []),
    ].join('\n'), share);
  });
  return clip([header, ...entries].join('\n'), maxDependencyBrief);
}
