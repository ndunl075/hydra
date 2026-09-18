import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assessBudgets, BudgetHoldError, checkBudgetLaunch, emptyBudgets, parseBudgets } from '../src/core/budgets';
import { BudgetStore } from '../src/core/budgetStore';
import { LocalStore } from '../src/core/store';
import { parseMessage, type Task, type SessionView } from '../src/core/model';
import { usageSnapshot } from '../src/core/usage';
import { TaskScheduler, validateSchedule } from '../src/core/scheduler';

const task = (n = 1): Task => ({ id: n.toString(16).padStart(12, '0'), title: 'Budget', prompt: 'literal $(data) ü', repository: path.resolve('.test-build/budget-repo'), worktree: path.resolve(`.test-build/budget-task-${n}`), branch: `agent/budget-${n}`, baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const codex = (input: number): SessionView => ({ version: 1, turns: [1, 2].map(n => ({ id: n.toString(16).padStart(12, '0'), provider: 'codex', prompt: 'fixture', text: '', status: 'completed', createdAt: `2026-09-17T23:00:0${n}.000Z`, threadUsage: { sessionId: '12345678-1234-7234-9234-123456789abc', input, output: 4, cacheRead: 2 } })) });
async function fixture() { const base = path.resolve('.test-build/budget-fixtures'); await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'budget-')); }
async function clean(root: string) { assert.ok(root.startsWith(path.resolve('.test-build/budget-fixtures') + path.sep)); await rm(root, { recursive: true, force: true }); }

test('budget limits and messages refuse invalid/ambiguous scope, billing and duplicate providers', () => {
  const rule = { provider: 'codex', action: 'hold', inputOutputTokens: 100 };
  assert.deepEqual(parseMessage({ type: 'saveBudgets', id: task().id, scope: 'task', budgets: [rule] }), { type: 'saveBudgets', id: task().id, scope: 'task', budgets: [rule] });
  for (const bad of [null, {}, [rule, rule], [{ ...rule, estimatedUsd: 1 }], [{ ...rule, inputOutputTokens: 0 }], [{ ...rule, inputOutputTokens: -1 }], [{ ...rule, inputOutputTokens: 1.5 }], [{ ...rule, inputOutputTokens: Infinity }], [{ ...rule, provider: 'other' }], [{ ...rule, action: 'stop' }], [{ ...rule, quota: 4 }], [{ provider: 'claude', action: 'warn' }], [{ provider: 'claude', action: 'warn', estimatedUsd: NaN }]]) assert.throws(() => parseBudgets(bad));
  assert.throws(() => parseMessage({ type: 'saveBudgets', id: task().id, scope: '/tmp/other', budgets: [] }), /scope/);
  assert.throws(() => parseMessage({ type: 'retryBudgetHold', id: 'bad' }), /ID/);
  assert.deepEqual(parseBudgets([]), []);
});

test('reported cumulative usage is counted once; task/project holds are provider-specific lower bounds', () => {
  const first = task(), second = task(2), retired = { ...task(3), state: 'discarded' as const };
  const tasks = [first, second, retired], settings = emptyBudgets();
  settings.tasks[first.id] = [{ provider: 'codex', action: 'warn', inputOutputTokens: 20 }];
  settings.projects[first.repository] = [{ provider: 'codex', action: 'hold', inputOutputTokens: 24 }, { provider: 'claude', action: 'hold', estimatedUsd: 1 }];
  const usage = usageSnapshot(tasks, id => id === retired.id ? codex(20) : undefined);
  assert.equal(usage.projects[first.repository]?.codex?.input, 20);
  const observations = assessBudgets(first, settings, usage);
  assert.equal(observations.find(item => item.scope === 'task')?.observed, undefined, 'No task measurement is invented');
  assert.ok(observations.find(item => item.provider === 'codex' && item.scope === 'project')?.partial);
  assert.throws(() => checkBudgetLaunch('codex', observations), BudgetHoldError);
  assert.deepEqual(checkBudgetLaunch('claude', observations), [], 'Unknown Claude money cannot hold or substitute Codex tokens');
  const repeated = usageSnapshot(tasks, id => id === retired.id ? codex(20) : undefined);
  assert.deepEqual(assessBudgets(first, settings, repeated), observations);
  settings.projects[first.repository]![0]!.action = 'warn';
  assert.equal(checkBudgetLaunch('codex', assessBudgets(first, settings, usage)).length, 1);
  settings.projects[first.repository]![0]!.inputOutputTokens = 25;
  assert.deepEqual(checkBudgetLaunch('codex', assessBudgets(first, settings, usage)), []);
});

test('Claude cache is separate; missing monetary estimates remain unavailable despite token threshold', () => {
  const current = { ...task(), provider: 'claude' as const }, settings = emptyBudgets();
  settings.tasks[current.id] = [{ provider: 'claude', action: 'hold', inputOutputTokens: 15, estimatedUsd: 0.01 }];
  const history: SessionView = { version: 1, turns: [{ id: 'aaaaaaaaaaaa', provider: 'claude', prompt: '', text: '', status: 'completed', createdAt: current.createdAt, usageSource: 'claude-result', usage: { input: 12, output: 3, cacheRead: 1000, estimatedUsd: 0.01 } }] };
  let observations = assessBudgets(current, settings, usageSnapshot([current], () => history));
  assert.equal(observations[0]?.observed, 15); assert.equal(observations[1]?.observed, 0.01);
  assert.throws(() => checkBudgetLaunch('claude', observations), /Task claude budget reached/);
  history.turns.push({ ...history.turns[0]!, id: 'bbbbbbbbbbbb', usage: { input: 1, output: 1 } });
  observations = assessBudgets(current, settings, usageSnapshot([current], () => history));
  assert.equal(observations[1]?.observed, undefined); assert.equal(observations[1]?.reached, false);
});

test('atomic budget store survives reload; unrelated session saves and failed writes cannot erase settings', async () => {
  const root = await fixture();
  try {
    const store = new BudgetStore(root), tasks = new LocalStore(root), settings = emptyBudgets(), current = task();
    assert.deepEqual(await store.load(), settings);
    settings.tasks[current.id] = [{ provider: 'codex', action: 'hold', inputOutputTokens: 1 }];
    settings.projects[current.repository] = [{ provider: 'claude', action: 'warn', estimatedUsd: 0.1 }];
    await store.save(settings); await tasks.save([current]); assert.deepEqual(await store.load(), settings);
    const original = await readFile(path.join(root, 'budgets.json'), 'utf8');
    await writeFile(path.join(root, 'budgets.json'), JSON.stringify({ version: 1, tasks: { invalid: [] }, projects: {} }));
    await assert.rejects(store.load(), /scope/);
    await writeFile(path.join(root, 'budgets.json'), original); assert.deepEqual(await store.load(), settings);
    const blocked = new BudgetStore(path.join(root, 'file')); await writeFile(path.join(root, 'file'), 'keep');
    await assert.rejects(blocked.save(settings)); assert.equal(await readFile(path.join(root, 'file'), 'utf8'), 'keep');
    assert.deepEqual(await store.load(), settings);
  } finally { await clean(root); }
});

test('held queue survives restart with exact follow-up; budget edits never auto-retry and warnings allow launch', async () => {
  const root = await fixture();
  try {
    let tasks = [task()], held = true, live = 0, launches = 0; const store = new LocalStore(root);
    const hooks = { tasks: () => tasks, enabled: () => true, capacity: () => 1, liveCount: () => live, persist: () => store.save(tasks), prepare: async (item: Task) => ({ commit: item.baseCommit, artifacts: [] }), launch: async (item: Task) => { launches++; live++; item.state = 'running'; }, budget: () => { if (held) throw new BudgetHoldError(['Threshold reached.']); return ['Budget warning']; } };
    const scheduler = new TaskScheduler(hooks), prompt = 'explicit "quoted" follow-up ü $(data)';
    tasks[0]!.sessionId = '12345678-1234-7234-9234-123456789abc'; tasks[0]!.sessionProvider = 'codex';
    await scheduler.enqueue(tasks[0]!, { type: 'followUp', prompt });
    assert.equal(launches, 0); assert.equal(tasks[0]!.schedule?.budgetHold, true);
    tasks = await store.load(); const restored = new TaskScheduler(hooks); restored.reconcile();
    held = false; await restored.drain(); assert.equal(launches, 0, 'Only explicit retry resumes held work');
    assert.deepEqual(tasks[0]!.schedule?.request, { type: 'followUp', prompt });
    await restored.retryBudgetHold(tasks[0]!); assert.equal(launches, 1);
    assert.deepEqual(tasks[0]!.schedule?.budgetWarnings, ['Budget warning']);
    await assert.rejects(restored.retryBudgetHold(tasks[0]!), /stopped budget/);
  } finally { await clean(root); }
});

test('holds recheck while capacity is full and after preparation; cancellation and failed retry save cannot launch', async () => {
  const current = task(); let held = false, live = 1, launches = 0, prepares = 0, failSave = false;
  const scheduler = new TaskScheduler({ tasks: () => [current], enabled: () => true, capacity: () => 1, liveCount: () => live,
    persist: async () => { if (failSave) throw new Error('Disk full'); }, prepare: async item => { prepares++; held = true; return { commit: item.baseCommit, artifacts: [] }; },
    launch: async () => { launches++; }, budget: () => { if (held) throw new BudgetHoldError(['Latest usage reached limit.']); return []; }
  });
  await scheduler.enqueue(current, { type: 'startManaged' }); held = true;
  await scheduler.drain(); assert.equal(current.schedule?.state, 'blocked'); assert.equal(prepares, 0, 'Hold is visible without waiting for capacity');
  held = false; live = 0; failSave = true;
  await assert.rejects(scheduler.retryBudgetHold(current), /Disk full/);
  assert.equal(current.schedule?.budgetHold, true); await scheduler.drain(); assert.equal(launches, 0);
  failSave = false; await scheduler.retryBudgetHold(current);
  assert.equal(prepares, 1); assert.equal(launches, 0); assert.equal(current.schedule?.budgetHold, true, 'Usage changed during preparation');
  validateSchedule(current.schedule);
  await scheduler.cancel(current); assert.equal(current.schedule?.budgetHold, undefined); validateSchedule(current.schedule);
  await scheduler.drain(); assert.equal(launches, 0);
});

test('an initial managed launch held after thread creation retries its native session without changing prompt', async () => {
  const current = task(); let held = true, request: unknown;
  const scheduler = new TaskScheduler({ tasks: () => [current], enabled: () => true, capacity: () => 1, liveCount: () => 0, persist: async () => {}, prepare: async item => ({ commit: item.baseCommit, artifacts: [] }), launch: async (_item, value) => { request = value; }, budget: () => { if (held) throw new BudgetHoldError(['Reached']); return []; } });
  await scheduler.enqueue(current, { type: 'startManaged' });
  current.sessionId = '12345678-1234-7234-9234-123456789abc'; current.sessionProvider = 'codex'; held = false;
  await scheduler.retryBudgetHold(current);
  assert.deepEqual(request, { type: 'followUp', prompt: current.prompt });
});
