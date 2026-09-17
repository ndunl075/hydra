import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink, access } from 'node:fs/promises';
import { git } from './git';
import { parseNameStatus } from './review';
import type { PreparedReview, ReviewedCommit } from './model';

const oid = /^[a-f0-9]{40,64}$/;
async function observe(worktree: string, branch: string) {
  const actualBranch = (await git(worktree, ['symbolic-ref', '--short', 'HEAD'])).trim();
  if (actualBranch !== branch) throw new Error('Task branch changed. Restore its recorded branch before preparing a review.');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const location = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim();
    if (await access(location).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Finish the active Git operation before preparing a review.');
  }
  const entries = await git(worktree, ['ls-files', '-v', '-z']);
  if (entries.split('\0').some(entry => entry && (entry[0] === 'S' || entry[0] !== entry[0]?.toUpperCase()))) throw new Error('Review requires a full worktree without skip-worktree or assume-unchanged entries.');
  const status = await git(worktree, ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  const records = status.split('\0');
  for (let i = 0; i < records.length && records[i]; i++) {
    const record = records[i]!;
    if (record.startsWith('??') || record[1] !== ' ' || !' MADRC'.includes(record[0]!)) throw new Error('Stage all saved task changes and resolve conflicts before preparing a review. Untracked and unstaged files are not silently included.');
    if ('RC'.includes(record[0]!)) i++;
  }
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
  const tree = (await git(worktree, ['write-tree'])).trim();
  if (!oid.test(head) || !oid.test(tree)) throw new Error('Invalid Git review identity.');
  const indexPath = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const index = await readFile(indexPath);
  return { head, tree, indexPath, index, indexHash: createHash('sha256').update(index).digest('hex') };
}
export async function prepareCommitReview(worktree: string, baseCommit: string, branch: string): Promise<PreparedReview> {
  if (!oid.test(baseCommit)) throw new Error('Invalid task base commit.');
  const state = await observe(worktree, branch);
  await git(worktree, ['merge-base', '--is-ancestor', baseCommit, state.head]);
  const files = parseNameStatus(await git(worktree, ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', baseCommit, state.tree, '--']), 'combined');
  if (!files.length) throw new Error('No task changes to review.');
  if (files.length > 1000) throw new Error('This review exceeds 1,000 files. Split the task before committing.');
  const prepared: PreparedReview = { token: randomBytes(12).toString('hex'), head: state.head, tree: state.tree, baseCommit, branch, indexHash: state.indexHash, files, createdAt: new Date().toISOString() };
  await assertCommitReview(worktree, prepared);
  return prepared;
}
export async function assertCommitReview(worktree: string, prepared: PreparedReview): Promise<void> {
  const state = await observe(worktree, prepared.branch);
  if (state.head !== prepared.head || state.tree !== prepared.tree || state.indexHash !== prepared.indexHash) throw new Error('Task changes no longer match this review. Prepare a fresh review before committing.');
}
/** A private copy pins the reviewed index. Native commit and hooks still run; the real index is untouched. */
export async function commitReviewed(worktree: string, prepared: PreparedReview, message: string, guard: () => void | Promise<void>): Promise<ReviewedCommit> {
  if (!message.trim() || message.length > 500 || message.includes('\0')) throw new Error('Enter a commit message of at most 500 characters.');
  await guard();
  await assertCommitReview(worktree, prepared);
  const indexPath = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const temporary = `${indexPath}.hydra-${randomBytes(12).toString('hex')}`;
  try {
    const bytes = await readFile(indexPath);
    if (createHash('sha256').update(bytes).digest('hex') !== prepared.indexHash) throw new Error('Task index changed. Prepare a fresh review.');
    await writeFile(temporary, bytes, { flag: 'wx' });
    await assertCommitReview(worktree, prepared);
    await guard();
    const headTree = (await git(worktree, ['rev-parse', `${prepared.head}^{tree}`])).trim();
    if (headTree !== prepared.tree) await git(worktree, ['commit', '-m', message], { GIT_INDEX_FILE: temporary });
    const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
    const tree = (await git(worktree, ['rev-parse', `${commit}^{tree}`])).trim();
    const parents = (await git(worktree, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ');
    const state = await observe(worktree, prepared.branch);
    await guard();
    if (tree !== prepared.tree || state.tree !== prepared.tree || state.indexHash !== prepared.indexHash || state.head !== commit || (headTree === prepared.tree ? commit !== prepared.head : parents.length !== 2 || parents[1] !== prepared.head)) throw new Error('Git hooks or another writer changed the result. No reviewed approval was recorded. Preserve the checkout and prepare a fresh review.');
    return { commit, tree, baseCommit: prepared.baseCommit, reviewedAt: new Date().toISOString() };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
