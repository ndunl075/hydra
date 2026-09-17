import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import { git, createWorktree } from '../src/core/worktrees';
import { prepareCommitReview, commitReviewed } from '../src/core/reviewCommit';
import { captureCommitReview } from '../src/core/review';
import { LocalStore } from '../src/core/store';
import { parseMessage, type Task } from '../src/core/model';
async function fixture() {
  const directory = path.resolve('.test-build/commit-fixtures'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'review-')), repository = path.join(root, 'main'); await mkdir(repository);
  await git(repository, ['init', '-b', 'main']); await git(repository, ['config', 'user.email', 'review@example.invalid']); await git(repository, ['config', 'user.name', 'Review Test']); await git(repository, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repository, 'keep.txt'), 'base\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'base']);
  const worktree = await createWorktree(repository, 'Commit review', '555555555555');
  return { root, repository: await realpath(repository), ...worktree };
}
test('reviewed commits pin staged Unicode/literal paths, include earlier commits, persist receipt, and preserve dirty main', async () => {
  const fixtureData = await fixture(); const { root, repository, worktree, branch, baseCommit } = fixtureData;
  try {
    await writeFile(path.join(repository, 'keep.txt'), 'dirty main\n');
    await writeFile(path.join(worktree, 'earlier.txt'), 'earlier commit\n'); await git(worktree, ['add', '.']); await git(worktree, ['commit', '-m', 'earlier']);
    await git(worktree, ['mv', 'keep.txt', 'renamed ü [literal].txt']); await writeFile(path.join(worktree, 'new ü.txt'), 'reviewed content\n'); await git(worktree, ['add', '-A']);
    const prepared = await prepareCommitReview(worktree, baseCommit, branch);
    assert.ok(prepared.files.some(file => file.path === 'earlier.txt'));
    assert.equal((await captureCommitReview(worktree, prepared, 'new ü.txt')).right.text, 'reviewed content\n');
    const renamed = await captureCommitReview(worktree, prepared, 'renamed ü [literal].txt'); assert.equal(renamed.left.text, 'base\n'); assert.equal(renamed.right.text, 'base\n');
    const receipt = await commitReviewed(worktree, prepared, 'Reviewed task', () => {});
    assert.equal(receipt.tree, prepared.tree); assert.notEqual(receipt.commit, prepared.head);
    assert.equal((await git(worktree, ['rev-parse', 'HEAD'])).trim(), receipt.commit); assert.equal(await git(worktree, ['status', '--porcelain=v1']), '');
    assert.equal(await readFile(path.join(repository, 'keep.txt'), 'utf8'), 'dirty main\n'); assert.equal((await git(repository, ['rev-parse', 'HEAD'])).trim(), baseCommit);
    const task: Task = { id: '555555555555', title: 'Review', prompt: 'Task', ...fixtureData, provider: 'codex', interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewedCommit: receipt };
    const store = new LocalStore(path.join(root, 'store')); await store.save([task]); assert.deepEqual((await store.load())[0]?.reviewedCommit, receipt);
    const preparedCommitted = await prepareCommitReview(worktree, baseCommit, branch);
    assert.equal((await commitReviewed(worktree, preparedCommitted, 'Already committed', () => {})).commit, receipt.commit);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('stale saved/index/HEAD/branch state and untracked files refuse commit without altering changes', async () => {
  const { root, worktree, branch, baseCommit } = await fixture();
  try {
    await writeFile(path.join(worktree, 'keep.txt'), 'reviewed\n'); await assert.rejects(prepareCommitReview(worktree, baseCommit, branch), /Stage all/);
    await git(worktree, ['add', '.']); const prepared = await prepareCommitReview(worktree, baseCommit, branch);
    await writeFile(path.join(worktree, 'keep.txt'), 'new edit\n'); await assert.rejects(commitReviewed(worktree, prepared, 'Test', () => {}), /Stage all/);
    assert.equal((await captureCommitReview(worktree, prepared, 'keep.txt')).right.text, 'reviewed\n');
    await git(worktree, ['add', '.']); await assert.rejects(commitReviewed(worktree, prepared, 'Test', () => {}), /no longer match/);
    const restaged = await prepareCommitReview(worktree, baseCommit, branch);
    await writeFile(path.join(worktree, 'extra.txt'), 'untracked\n'); await assert.rejects(commitReviewed(worktree, restaged, 'Test', () => {}), /Stage all/); await rm(path.join(worktree, 'extra.txt'));
    await git(worktree, ['commit', '-m', 'external commit']); await assert.rejects(commitReviewed(worktree, restaged, 'Test', () => {}), /no longer match/);
    await git(worktree, ['switch', '-c', 'other']); await assert.rejects(prepareCommitReview(worktree, baseCommit, branch), /branch changed/);
    assert.equal(await readFile(path.join(worktree, 'keep.txt'), 'utf8'), 'new edit\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('writer guard and failed native hooks preserve HEAD and original staging and clean private indexes', async () => {
  const { root, repository, worktree, branch, baseCommit } = await fixture();
  try {
    await writeFile(path.join(worktree, 'keep.txt'), 'reviewed\n'); await git(worktree, ['add', '.']); const prepared = await prepareCommitReview(worktree, baseCommit, branch);
    await assert.rejects(commitReviewed(worktree, prepared, 'Test', () => { throw new Error('Writer running'); }), /Writer running/);
    const hooks = path.join(repository, '.git', 'hooks'); await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "fixture hook refused" >&2\nexit 1\n'); await chmod(path.join(hooks, 'pre-commit'), 0o755);
    const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim(); const before = await readFile(index);
    await assert.rejects(commitReviewed(worktree, prepared, 'Test', () => {}), /fixture hook refused/);
    assert.deepEqual(await readFile(index), before); assert.equal((await git(worktree, ['rev-parse', 'HEAD'])).trim(), baseCommit);
    assert.ok(!(await readdir(path.dirname(index))).some(name => name.includes('.hydra-')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('hooks that alter the committed tree cannot earn a review receipt and preserve the original index', async () => {
  const { root, repository, worktree, branch, baseCommit } = await fixture();
  try {
    await writeFile(path.join(worktree, 'keep.txt'), 'reviewed\n'); await git(worktree, ['add', '.']); const prepared = await prepareCommitReview(worktree, baseCommit, branch);
    const hook = path.join(repository, '.git', 'hooks', 'pre-commit'); await writeFile(hook, '#!/bin/sh\nprintf "hook content\\n" > keep.txt\ngit add keep.txt\n'); await chmod(hook, 0o755);
    const index = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim(); const before = await readFile(index);
    await assert.rejects(commitReviewed(worktree, prepared, 'Test', () => {}));
    assert.deepEqual(await readFile(index), before); assert.equal((await captureCommitReview(worktree, prepared, 'keep.txt')).right.text, 'reviewed\n'); assert.equal(await readFile(path.join(worktree, 'keep.txt'), 'utf8'), 'hook content\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('assume-unchanged, active Git operations, and malformed review actions fail safely', async () => {
  const { root, worktree, branch, baseCommit } = await fixture();
  try {
    await git(worktree, ['update-index', '--assume-unchanged', 'keep.txt']); await assert.rejects(prepareCommitReview(worktree, baseCommit, branch), /assume-unchanged/);
    await git(worktree, ['update-index', '--no-assume-unchanged', 'keep.txt']);
    const operation = (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'CHERRY_PICK_HEAD'])).trim(); await writeFile(operation, baseCommit); await assert.rejects(prepareCommitReview(worktree, baseCommit, branch), /active Git operation/);
    assert.throws(() => parseMessage({ type: 'commitReviewed', id: '555555555555', token: 'bad', message: 'Test' }));
    assert.throws(() => parseMessage({ type: 'commitReviewed', id: '555555555555', token: 'a'.repeat(24), message: ' ' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
