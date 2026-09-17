import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { git, createWorktree } from '../src/core/worktrees';
import { captureReview, parseNameStatus, reviewChanges, reviewFiles, textLimit } from '../src/core/review';
import { parseMessage } from '../src/core/model';
async function fixture() {
  const base = path.resolve('.test-build/review-fixtures'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'spaces ü-')), repository = path.join(root, 'main repo'); await mkdir(repository);
  await git(repository, ['init', '-b', 'main']); await git(repository, ['config', 'user.email', 'review@example.invalid']); await git(repository, ['config', 'user.name', 'Review Test']); await git(repository, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries({ 'keep.txt': 'base\n', 'cancel.txt': 'unchanged\n', 'committed-delete.txt': 'committed deletion\n', 'staged-delete.txt': 'staged deletion\n', 'unstaged-delete.txt': 'unstaged deletion\n', 'commit rename.txt': 'unique committed rename content\n'.repeat(50), 'stage rename.txt': 'unique staged rename content\n'.repeat(50) })) await writeFile(path.join(repository, name), text);
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'base']);
  const task = await createWorktree(repository, 'Review', '444444444444');
  return { root, repository: await realpath(repository), ...task };
}
test('review parser keeps both rename paths, literal Unicode/newline paths, and rejects malformed messages', () => {
  assert.deepEqual(parseNameStatus('R100\0old name\0new\nü.txt\0D\0deleted.txt\0', 'committed'), [{ layer: 'committed', status: 'R100', beforePath: 'old name', path: 'new\nü.txt' }, { layer: 'committed', status: 'D', path: 'deleted.txt' }]);
  assert.throws(() => parseNameStatus('R100\0old\0', 'staged'), /Incomplete/);
  assert.throws(() => parseMessage({ type: 'openDiff', id: '444444444444', path: 'keep.txt', layer: 'exec' }));
  assert.throws(() => parseMessage({ type: 'openDiff', id: '../bad', path: 'keep.txt', layer: 'staged' }));
});
test('native review captures all layers and renamed/deleted/untracked sides without changing dirty main or Git state', async () => {
  const { root, repository, worktree, baseCommit } = await fixture();
  try {
    await writeFile(path.join(repository, 'keep.txt'), 'dirty main\n');
    await writeFile(path.join(worktree, 'keep.txt'), 'committed\n');
    await writeFile(path.join(worktree, 'added then deleted.txt'), 'committed addition\n');
    await git(worktree, ['mv', 'commit rename.txt', 'committed rename ü.txt']); await rm(path.join(worktree, 'committed-delete.txt'));
    await git(worktree, ['add', '.']); await git(worktree, ['commit', '-m', 'task committed changes']);
    await git(worktree, ['mv', 'stage rename.txt', 'staged rename ü.txt']);
    await rm(path.join(worktree, 'staged-delete.txt')); await rm(path.join(worktree, 'added then deleted.txt'));
    await writeFile(path.join(worktree, 'keep.txt'), 'staged\n'); await writeFile(path.join(worktree, 'cancel.txt'), 'staged cancellation\n');
    await git(worktree, ['add', '.']);
    await writeFile(path.join(worktree, 'keep.txt'), 'saved\n'); await writeFile(path.join(worktree, 'cancel.txt'), 'unchanged\n');
    await rm(path.join(worktree, 'unstaged-delete.txt')); await writeFile(path.join(worktree, 'untracked ü.txt'), 'untracked\n');
    const before = await git(worktree, ['status', '--porcelain=v1', '-z']), head = await git(worktree, ['rev-parse', 'HEAD']);
    for (const [layer, left, right] of [['combined', 'base\n', 'saved\n'], ['committed', 'base\n', 'committed\n'], ['staged', 'committed\n', 'staged\n'], ['unstaged', 'staged\n', 'saved\n']] as const) {
      const snapshot = await captureReview(worktree, baseCommit, 'keep.txt', layer);
      assert.equal(snapshot.left.text, left); assert.equal(snapshot.right.text, right);
    }
    const changes = await reviewChanges(worktree, baseCommit);
    assert.ok(!changes.some(change => change.path === 'cancel.txt' && change.layer === 'combined'));
    assert.ok(changes.some(change => change.path === 'cancel.txt' && change.layer === 'staged'));
    assert.ok(changes.some(change => change.path === 'cancel.txt' && change.layer === 'unstaged'));
    for (const [layer, name, old] of [['committed', 'committed rename ü.txt', 'commit rename.txt'], ['staged', 'staged rename ü.txt', 'stage rename.txt']] as const) {
      const snapshot = await captureReview(worktree, baseCommit, name, layer);
      assert.equal(snapshot.beforePath, old); assert.equal(snapshot.left.text, snapshot.right.text); assert.equal(snapshot.left.absent, undefined);
    }
    for (const [layer, name] of [['committed', 'committed-delete.txt'], ['staged', 'staged-delete.txt'], ['unstaged', 'unstaged-delete.txt']] as const) {
      const snapshot = await captureReview(worktree, baseCommit, name, layer);
      assert.ok(snapshot.left.text); assert.equal(snapshot.right.text, ''); assert.equal(snapshot.right.absent, true);
    }
    const untracked = await captureReview(worktree, baseCommit, 'untracked ü.txt', 'untracked'); assert.equal(untracked.left.absent, true); assert.equal(untracked.right.text, 'untracked\n');
    assert.equal((await captureReview(worktree, baseCommit, 'added then deleted.txt', 'staged')).left.text, 'committed addition\n');
    assert.ok((await reviewFiles(worktree, baseCommit)).some(file => file.path === 'added then deleted.txt' && file.changes?.length === 2));
    assert.equal(await git(worktree, ['status', '--porcelain=v1', '-z']), before); assert.equal(await git(worktree, ['rev-parse', 'HEAD']), head);
    assert.equal(await readFile(path.join(repository, 'keep.txt'), 'utf8'), 'dirty main\n');
    await assert.rejects(captureReview(worktree, baseCommit, 'keep.txt', 'untracked'), /no longer available/);
    await assert.rejects(captureReview(worktree, baseCommit, '../../main repo/keep.txt', 'unstaged'), /relative/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('binary, attributes, invalid UTF-8, large files, gitlinks, and escaping junctions never become invented text diffs', async () => {
  const { root, repository, worktree, baseCommit } = await fixture();
  try {
    await writeFile(path.join(worktree, 'binary.bin'), Buffer.from([0, 1, 255])); await writeFile(path.join(worktree, 'invalid.txt'), Buffer.from([255, 254, 253]));
    await writeFile(path.join(worktree, 'large.txt'), Buffer.alloc(textLimit + 1, 97)); await writeFile(path.join(worktree, '.gitattributes'), 'forced.bin -diff\n'); await writeFile(path.join(worktree, 'forced.bin'), 'ASCII but explicitly binary\n');
    for (const [name, kind] of [['binary.bin', 'binary'], ['invalid.txt', 'unsupported'], ['large.txt', 'large'], ['forced.bin', 'binary']] as const) {
      const snapshot = await captureReview(worktree, baseCommit, name, 'untracked'); assert.equal(snapshot.right.kind, kind); assert.equal(snapshot.right.text, undefined);
    }
    await git(worktree, ['add', 'large.txt']); assert.equal((await captureReview(worktree, baseCommit, 'large.txt', 'staged')).right.kind, 'large');
    await git(worktree, ['update-index', '--add', '--cacheinfo', `160000,${baseCommit},submodule`]);
    assert.equal((await captureReview(worktree, baseCommit, 'submodule', 'staged')).right.kind, 'submodule');
    const outside = path.join(worktree, 'outside'); await symlink(repository, outside, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(captureReview(worktree, baseCommit, 'outside/keep.txt', 'untracked'));
    await mkdir(path.join(worktree, 'tracked directory')); await writeFile(path.join(worktree, 'tracked directory', 'keep.txt'), 'original inside worktree\n');
    await git(worktree, ['add', 'tracked directory/keep.txt']); await git(worktree, ['commit', '-m', 'tracked directory']);
    await rm(path.join(worktree, 'tracked directory'), { recursive: true });
    await symlink(repository, path.join(worktree, 'tracked directory'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(captureReview(worktree, baseCommit, 'tracked directory/keep.txt', 'unstaged'), /escapes/);
    await git(worktree, ['config', 'core.filemode', 'false']); await git(worktree, ['update-index', '--chmod=+x', 'keep.txt']);
    await writeFile(path.join(worktree, 'keep.txt'), 'saved mode test\n');
    const mode = await captureReview(worktree, baseCommit, 'keep.txt', 'unstaged'); assert.equal(mode.left.mode, '100755'); assert.equal(mode.right.mode, '100755');
    if (process.platform !== 'win32') {
      await symlink(path.join(repository, 'keep.txt'), path.join(worktree, 'link.txt'));
      const link = await captureReview(worktree, baseCommit, 'link.txt', 'untracked'); assert.equal(link.right.mode, '120000'); assert.equal(link.right.text, path.join(repository, 'keep.txt'));
      await writeFile(path.join(worktree, ':(glob)literal.txt'), 'literal path\n'); await git(worktree, ['--literal-pathspecs', 'add', '--', ':(glob)literal.txt']);
      assert.equal((await captureReview(worktree, baseCommit, ':(glob)literal.txt', 'staged')).right.text, 'literal path\n');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unmerged index content fails with a native conflict workflow message', async () => {
  const { root, repository, worktree, baseCommit, branch } = await fixture();
  try {
    await writeFile(path.join(repository, 'keep.txt'), 'main conflicting\n'); await git(repository, ['add', 'keep.txt']); await git(repository, ['commit', '-m', 'main conflict']);
    await writeFile(path.join(worktree, 'keep.txt'), 'task conflicting\n'); await git(worktree, ['add', 'keep.txt']); await git(worktree, ['commit', '-m', 'task conflict']);
    await assert.rejects(git(worktree, ['merge', 'main']));
    assert.equal((await git(worktree, ['branch', '--show-current'])).trim(), branch);
    await assert.rejects(captureReview(worktree, baseCommit, 'keep.txt', 'staged'), /conflicts|Conflicts/);
    await assert.rejects(captureReview(worktree, baseCommit, 'keep.txt', 'unstaged'), /conflicts|Conflicts/);
    assert.equal((await captureReview(worktree, baseCommit, 'keep.txt', 'committed')).right.text, 'task conflicting\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
