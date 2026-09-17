import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from '../src/core/store';
import { OwnershipLock } from '../src/core/ownership';
import { changedFiles, createWorktree, git, parseStatus, resolveTaskFile } from '../src/core/worktrees';
import { parseMessage, type Task } from '../src/core/model';
import { assertCliAllowed, createHandoffWorkspace, handoffTask, parseHandoff, officialProviders } from '../src/core/handoff';

const fixtures = path.resolve('.test-build', 'fixtures');
async function fixture() {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'git spaces ü-'));
  const repository = path.join(root, 'main repo');
  await mkdir(repository);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.email', 'hydra-test@example.invalid']);
  await git(repository, ['config', 'user.name', 'Hydra Test']);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repository, 'keep.txt'), 'base\n');
  await writeFile(path.join(repository, 'delete.txt'), 'delete me\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'fixture']);
  return { root, repository: await realpath(repository) };
}
test('three worktrees isolate committed starting points from dirty main, using paths with spaces and Unicode', async () => {
  const { root, repository } = await fixture();
  try {
    await writeFile(path.join(repository, 'keep.txt'), 'main dirty\n');
    const tasks = [];
    for (const id of ['111111111111', '222222222222', '333333333333']) tasks.push(await createWorktree(repository, 'Same task', id));
    assert.equal(new Set(tasks.map(task => task.branch)).size, 3);
    assert.equal(new Set(tasks.map(task => task.worktree)).size, 3);
    for (const task of tasks) {
      assert.equal(await readFile(path.join(task.worktree, 'keep.txt'), 'utf8'), 'base\n');
      assert.equal((await git(task.worktree, ['branch', '--show-current'])).trim(), task.branch);
      assert.equal(task.integrationTarget, 'main');
    }
    await writeFile(path.join(tasks[0]!.worktree, 'keep.txt'), 'task one\n');
    assert.equal(await readFile(path.join(tasks[1]!.worktree, 'keep.txt'), 'utf8'), 'base\n');
    assert.equal(await readFile(path.join(repository, 'keep.txt'), 'utf8'), 'main dirty\n');
    assert.equal((await git(repository, ['branch', '--show-current'])).trim(), 'main');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('refuses a worktree root inside the repository, including junction escapes, and invalid IDs', async () => {
  const { root, repository } = await fixture();
  try {
    await assert.rejects(createWorktree(repository, 'task', '444444444444', path.join(repository, 'nested')), /outside/);
    const alias = path.join(root, 'alias');
    await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createWorktree(repository, 'task', '444444444444', path.join(alias, 'new')), /outside/);
    await assert.rejects(createWorktree(repository, 'task', '../escape'), /Invalid task ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('change inventory includes committed, staged, unstaged, deleted, and untracked files', async () => {
  const { root, repository } = await fixture();
  try {
    const task = await createWorktree(repository, 'changes', '555555555555');
    await writeFile(path.join(task.worktree, 'committed.txt'), 'committed\n');
    await git(task.worktree, ['add', '.']);
    await git(task.worktree, ['commit', '-m', 'committed change']);
    await writeFile(path.join(task.worktree, 'staged.txt'), 'staged\n');
    await git(task.worktree, ['add', 'staged.txt']);
    await writeFile(path.join(task.worktree, 'keep.txt'), 'unstaged\n');
    await rm(path.join(task.worktree, 'delete.txt'));
    await writeFile(path.join(task.worktree, 'untracked ü.txt'), 'untracked\n');
    const files = await changedFiles(task.worktree, task.baseCommit);
    assert.deepEqual(files.map(file => file.path), ['committed.txt', 'delete.txt', 'keep.txt', 'staged.txt', 'untracked ü.txt']);
    assert.equal(files.find(file => file.path === 'untracked ü.txt')?.status, '??');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('file access rejects traversal and symlinks outside the task worktree', async () => {
  const { root, repository } = await fixture();
  try {
    const task = await createWorktree(repository, 'paths', '666666666666');
    assert.equal(await resolveTaskFile(task.worktree, 'keep.txt'), await realpath(path.join(task.worktree, 'keep.txt')));
    await assert.rejects(resolveTaskFile(task.worktree, '../../main repo/keep.txt'), /escapes/);
    const link = path.join(task.worktree, 'outside');
    await symlink(repository, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveTaskFile(task.worktree, 'outside/keep.txt'), /Symlink escapes/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('NUL-delimited status preserves spaces, newlines, and rename paths', () => {
  assert.deepEqual(parseStatus('R  new name.txt\0old name.txt\0?? file\nname.txt\0'), [{ status: 'R ', path: 'new name.txt' }, { status: '??', path: 'file\nname.txt' }]);
});
test('webview messages reject unknown actions, malformed providers, and invalid IDs', () => {
  assert.throws(() => parseMessage({ type: 'launch', id: '../../escape' }));
  assert.throws(() => parseMessage({ type: 'exec', command: 'anything' }));
  assert.throws(() => parseMessage({ type: 'create', title: 'task', prompt: 'go', provider: 'other', repository: 'repo' }));
  assert.throws(() => parseMessage({ type: 'create', title: '', prompt: 'go', provider: 'codex', repository: 'repo' }));
  assert.deepEqual(parseMessage({ type: 'select', id: '111111111111' }), { type: 'select', id: '111111111111' });
});
test('atomic store serializes concurrent saves and preserves corrupt input instead of resetting it', async () => {
  const { root, repository } = await fixture();
  try {
    const directory = path.join(root, 'store');
    const store = new LocalStore(directory);
    const worktree = await createWorktree(repository, 'store', '777777777777');
    const task: Task = { id: '777777777777', title: 'Saved', prompt: 'goal', repository, ...worktree, provider: 'codex', interface: 'interactive-cli', state: 'external', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await Promise.all([store.save([]), store.save([task])]);
    assert.deepEqual(await store.load(), [task]);
    await writeFile(path.join(directory, 'tasks.json'), '{ corrupt');
    await assert.rejects(store.load());
    assert.equal(await readFile(path.join(directory, 'tasks.json'), 'utf8'), '{ corrupt');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('repository ownership is exclusive and can be reacquired after release', async () => {
  const { root, repository } = await fixture();
  try {
    const locks = path.join(root, 'locks');
    const first = new OwnershipLock();
    const second = new OwnershipLock();
    await first.acquire(locks, repository);
    await assert.rejects(second.acquire(locks, repository), /another VS Code window/);
    await first.release();
    await second.acquire(locks, repository);
    await second.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official handoff selects only the exact worktree and preserves prompts as data', async () => {
  const { root, repository } = await fixture();
  try {
    const worktree = await createWorktree(repository, 'handoff', '888888888888');
    const task: Task = { id: '888888888888', title: 'Official task', prompt: 'Keep "quotes", Unicode ü, and $(literal text).\nNo shell execution.', repository, ...worktree, provider: 'claude', interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    for (const provider of ['claude', 'codex'] as const) {
      const filename = await createHandoffWorkspace(path.join(root, 'handoffs'), task, provider);
      const workspace = JSON.parse(await readFile(filename, 'utf8'));
      assert.deepEqual(workspace.folders.map((folder: { path: string }) => folder.path), [task.worktree]);
      assert.deepEqual(workspace.extensions.recommendations, [officialProviders[provider].extensionId]);
      const descriptor = parseHandoff(workspace.settings['hydra.handoff'])!;
      assert.equal(descriptor.task.provider, provider);
      assert.equal(descriptor.task.prompt, task.prompt);
      assert.equal(descriptor.task.branch, task.branch);
      assert.equal('interface' in descriptor.task, false);
      assert.throws(() => parseHandoff({ ...descriptor, version: 2 }));
      for (const invalid of [{ worktree: '../escape' }, { provider: 'other' }, { id: '../../escape' }, { branch: 'main' }]) {
        assert.throws(() => parseHandoff({ ...descriptor, task: { ...descriptor.task, ...invalid } }));
      }
    }
    assert.equal(task.interface, 'interactive-cli', 'Preparing a descriptor does not implicitly start a session');
    assert.equal(await readFile(path.join(repository, 'keep.txt'), 'utf8'), 'base\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('handoff persists ownership before opening and retains it after an ambiguous open failure', async () => {
  const { root, repository } = await fixture();
  try {
    const worktree = await createWorktree(repository, 'ownership', '999999999999');
    const task: Task = { id: '999999999999', title: 'External', prompt: 'goal', repository, ...worktree, provider: 'claude', interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const store = new LocalStore(path.join(root, 'store'));
    const persist = () => store.save([task]);
    let opens = 0;
    const open = async () => { opens++; assert.equal((await store.load())[0]?.interface, 'official-extension'); };
    await assert.rejects(handoffTask(task, path.join(root, 'handoffs'), 'codex', true, persist, open), /Stop this task terminal/);
    assert.equal(opens, 0);
    await assert.rejects(handoffTask(task, path.join(root, 'handoffs'), 'codex', false, persist, async () => { await open(); throw new Error('Ambiguous window failure'); }), /Ambiguous/);
    const recovered = (await store.load())[0]!;
    assert.equal(recovered.interface, 'official-extension');
    assert.equal(recovered.state, 'external');
    assert.equal(recovered.provider, 'codex');
    assert.match(recovered.error!, /could not be confirmed/);
    assert.throws(() => assertCliAllowed(recovered), /external extension/);
    await assert.rejects(handoffTask(task, path.join(root, 'handoffs'), 'claude', false, persist, open), /already externally owned/);
    assert.equal(opens, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
