import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertDiscardable, prepareDiscard, confirmDiscard, restoreDiscarded, validateDiscardReceipt } from '../src/core/discard';
import { createWorktree, git } from '../src/core/worktrees';
import { LocalStore } from '../src/core/store';
import { parseMessage, type Task } from '../src/core/model';
import { assertCliAllowed, assertHandoffAllowed } from '../src/core/handoff';
import { TaskScheduler, configureSchedule } from '../src/core/scheduler';
import { ManagedSessions } from '../src/core/managedSessions';
import { SessionStore } from '../src/core/sessionStore';
import { prepareScheduledTask } from '../src/core/schedulerGit';
const guard = async () => {};

async function fixture() {
  const directory = path.resolve('.test-build/discard-fixtures'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'discard-')), repository = path.join(root, 'main'); await mkdir(repository);
  await git(repository, ['init', '-b', 'main']); await git(repository, ['config', 'user.name', 'Discard Test']); await git(repository, ['config', 'user.email', 'discard@example.invalid']); await git(repository, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repository, 'keep.txt'), 'base\n'); await writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Base']);
  const canonical = await realpath(repository), created = await createWorktree(canonical, 'Discard', '123456abcdef');
  const stamp = new Date().toISOString(), task: Task = { id: '123456abcdef', title: 'Discard test', prompt: 'Local task', repository: canonical, ...created, provider: 'codex', interface: 'interactive-cli', state: 'idle', createdAt: stamp, updatedAt: stamp };
  const tasks = [task], store = new LocalStore(path.join(root, 'records')); const save = (records: Task[]) => store.save(records);
  await save(tasks);
  return { root, repository: canonical, task, tasks, store, save };
}

test('discard inventories unmerged and dirty work, preserves both checkouts, branch/index, ignored data and diagnostics, then reloads and restores without launch', async () => {
  const f = await fixture(); try {
    const file = path.join(f.task.worktree, 'keep.txt'); await writeFile(file, 'commit\n'); await git(f.task.worktree, ['add', '.']); await git(f.task.worktree, ['commit', '-m', 'Task result']);
    await writeFile(file, 'staged\n'); await git(f.task.worktree, ['add', '.']); await writeFile(file, 'working\n');
    await writeFile(path.join(f.task.worktree, 'untracked ü.txt'), 'untracked\n'); await writeFile(path.join(f.task.worktree, 'ignored.txt'), 'retained secret\n'); await writeFile(path.join(f.repository, 'keep.txt'), 'main unsaved-to-Git\n');
    const sessions = new SessionStore(path.join(f.root, 'sessions')); await sessions.save(f.task.id, { version: 1, turns: [] });
    const index = (await git(f.task.worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim(), indexBefore = await readFile(index), head = (await git(f.task.worktree, ['rev-parse', 'HEAD'])).trim(), mainHead = (await git(f.repository, ['rev-parse', 'HEAD'])).trim();
    const review = await prepareDiscard(f.task, f.tasks, guard); assert.equal(review.unmergedCommits.length, 1); assert.equal(review.unmergedCommits[0]?.subject, 'Task result'); assert.deepEqual(review.changes.map(file => file.status), ['MM', '??']);
    assert.equal(f.task.state, 'idle'); await confirmDiscard(f.task, f.tasks, review, guard, f.save); assert.equal(f.task.state, 'discarded');
    assert.deepEqual(await readFile(index), indexBefore); assert.equal((await git(f.task.worktree, ['rev-parse', 'HEAD'])).trim(), head); assert.equal((await git(f.repository, ['rev-parse', 'HEAD'])).trim(), mainHead);
    assert.equal(await readFile(file, 'utf8'), 'working\n'); assert.equal(await readFile(path.join(f.task.worktree, 'untracked ü.txt'), 'utf8'), 'untracked\n'); assert.equal(await readFile(path.join(f.task.worktree, 'ignored.txt'), 'utf8'), 'retained secret\n'); assert.equal(await readFile(path.join(f.repository, 'keep.txt'), 'utf8'), 'main unsaved-to-Git\n');
    assert.deepEqual(await sessions.load(f.task.id), { version: 1, turns: [] });
    const loaded = await f.store.load(), restored = loaded[0]!; assert.equal(restored.state, 'discarded'); validateDiscardReceipt(restored.discard);
    await writeFile(file, 'manually retained edit\n'); await restoreDiscarded(restored, loaded, guard, f.save); assert.equal(restored.state, 'interrupted'); assert.equal(restored.discard, undefined); assert.equal(restored.schedule?.request, undefined); assert.equal(await readFile(file, 'utf8'), 'manually retained edit\n'); assert.equal((await f.store.load())[0]?.state, 'interrupted');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('stale tracked, staged, same-length untracked content and target commits refuse discard without metadata mutation', async () => {
  const f = await fixture(); try {
    const file = path.join(f.task.worktree, 'keep.txt'), extra = path.join(f.task.worktree, 'new.txt'); await writeFile(extra, 'one');
    for (const change of [async () => writeFile(file, 'new\n'), async () => git(f.task.worktree, ['add', '.']), async () => writeFile(extra, 'two'), async () => git(f.repository, ['commit', '--allow-empty', '-m', 'Target moved'])]) {
      const review = await prepareDiscard(f.task, f.tasks, guard); await change(); await assert.rejects(confirmDiscard(f.task, f.tasks, review, guard, f.save), /changed since/); assert.equal(f.task.discard, undefined); assert.equal((await f.store.load())[0]?.state, 'idle');
    }
    await git(f.task.worktree, ['commit', '-m', 'Changed task head']); const review = await prepareDiscard(f.task, f.tasks, guard); await git(f.task.worktree, ['commit', '--allow-empty', '-m', 'Another head']); await assert.rejects(confirmDiscard(f.task, f.tasks, review, guard, f.save), /changed since/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('live, external, queued, uncertain and dependent tasks refuse; guards are rechecked after asynchronous review', async () => {
  const f = await fixture(); try {
    for (const state of ['running', 'external'] as const) { f.task.state = state; assert.throws(() => assertDiscardable(f.task, f.tasks), /Stop task writers/); }
    f.task.state = 'idle'; f.task.interface = 'official-extension'; assert.throws(() => assertDiscardable(f.task, f.tasks), /Stop task writers/); f.task.interface = 'interactive-cli';
    for (const schedule of [{ state: 'queued', dependencies: [], artifacts: [] }, { state: 'interrupted', dependencies: [], artifacts: [], uncertain: true }, { state: 'interrupted', dependencies: [], artifacts: [], request: { type: 'launch' } }] satisfies NonNullable<Task['schedule']>[]) { f.task.schedule = structuredClone(schedule); assert.throws(() => assertDiscardable(f.task, f.tasks), /Stop task writers/); }
    f.task.schedule = undefined;
    const dependent: Task = { ...f.task, id: 'aaaaaaaaaaaa', schedule: { state: 'finished', dependencies: [f.task.id], artifacts: [] } }; assert.throws(() => assertDiscardable(f.task, [f.task, dependent]), /depends on/);
    await assert.rejects(prepareDiscard(f.task, f.tasks, async () => { throw new Error('Unsaved buffer'); }), /Unsaved buffer/);
    const review = await prepareDiscard(f.task, f.tasks, guard); let count = 0;
    await assert.rejects(confirmDiscard(f.task, f.tasks, review, async () => { if (++count === 2) f.task.state = 'running'; }, f.save), /Stop task writers/); assert.equal(f.task.discard, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('failed durable saves leave both discard and restore state unchanged and retryable', async () => {
  const f = await fixture(); try {
    const review = await prepareDiscard(f.task, f.tasks, guard), fail = async () => { throw new Error('disk full'); };
    await assert.rejects(confirmDiscard(f.task, f.tasks, review, guard, fail), /disk full/); assert.equal(f.task.state, 'idle'); assert.equal((await f.store.load())[0]?.state, 'idle');
    await confirmDiscard(f.task, f.tasks, review, guard, f.save); await assert.rejects(restoreDiscarded(f.task, f.tasks, guard, fail), /disk full/); assert.equal(f.task.state, 'discarded'); assert.equal((await f.store.load())[0]?.state, 'discarded');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('discarded records and dependencies cannot launch through terminal, handoff, managed or scheduler interfaces', async () => {
  const f = await fixture(); try {
    await confirmDiscard(f.task, f.tasks, await prepareDiscard(f.task, f.tasks, guard), guard, f.save);
    assert.throws(() => assertCliAllowed(f.task), /Restore/); assert.throws(() => assertHandoffAllowed(f.task, false), /Restore/);
    const managed = new ManagedSessions(new SessionStore(path.join(f.root, 'sessions')), guard, () => {}, () => {}); await assert.rejects(managed.start(f.task, 'never-execute', 'never send'), /Restore/);
    const scheduler = new TaskScheduler({ tasks: () => f.tasks, capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: guard, prepare: async () => assert.fail('No preparation'), launch: async () => assert.fail('No launch') }); await assert.rejects(scheduler.enqueue(f.task, { type: 'launch' }), /Restore/);
    assert.throws(() => configureSchedule(f.task, f.tasks, []), /Restore/); await assert.rejects(prepareScheduledTask(f.task, f.tasks, guard), /Restore/);
    const dependent: Task = { ...f.task, state: 'idle', discard: undefined, id: 'bbbbbbbbbbbb' }; assert.throws(() => configureSchedule(dependent, [f.task, dependent], [f.task.id]), /Restore/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('invalid receipts and active discarded records refuse restart; client messages require exact IDs and review tokens', async () => {
  const f = await fixture(); try {
    assert.deepEqual(parseMessage({ type: 'prepareDiscard', id: f.task.id }), { type: 'prepareDiscard', id: f.task.id }); assert.throws(() => parseMessage({ type: 'confirmDiscard', id: f.task.id, token: 'invalid' }), /token/);
    await confirmDiscard(f.task, f.tasks, await prepareDiscard(f.task, f.tasks, guard), guard, f.save);
    f.task.discard!.changes = [{ path: '../escape.txt', status: '??' }]; await f.save(f.tasks); await assert.rejects(f.store.load(), /Invalid discard receipt/);
    f.task.discard!.changes = []; f.task.schedule = { state: 'queued', dependencies: [], artifacts: [], request: { type: 'launch' } }; await f.save(f.tasks); await assert.rejects(f.store.load(), /active or uncertain/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('replaced identity and hidden index entries refuse preview while preserving all files', async () => {
  const f = await fixture(); try {
    const original = f.task.worktree; f.task.worktree = f.repository; await assert.rejects(prepareDiscard(f.task, f.tasks, guard), /exact separate/); f.task.worktree = original;
    const originalBranch = f.task.branch; f.task.branch = 'different'; await assert.rejects(prepareDiscard(f.task, f.tasks, guard), /identity changed/); f.task.branch = originalBranch;
    await git(f.task.worktree, ['update-index', '--assume-unchanged', 'keep.txt']); await writeFile(path.join(f.task.worktree, 'keep.txt'), 'hidden edit\n'); await assert.rejects(prepareDiscard(f.task, f.tasks, guard), /hidden index/); assert.equal(await readFile(path.join(f.task.worktree, 'keep.txt'), 'utf8'), 'hidden edit\n');
    await git(f.task.worktree, ['update-index', '--no-assume-unchanged', 'keep.txt']);
    await git(f.task.worktree, ['update-index', '--add', '--cacheinfo', `160000,${f.task.baseCommit},submodule`]); await assert.rejects(prepareDiscard(f.task, f.tasks, guard), /submodules/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
