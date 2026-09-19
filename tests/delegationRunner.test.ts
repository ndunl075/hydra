import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeDelegatedSession, assertDelegatedManagedDispatch, reserveDelegatedExecution, recordDelegatedSession, startDelegatedExecution, validateDelegatedExecution } from '../src/core/delegationRunner';
import { TaskScheduler } from '../src/core/scheduler';
import { BudgetHoldError } from '../src/core/budgets';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from '../src/core/store';
import type { Task } from '../src/core/model';
const sessionId = '12345678-1234-1234-1234-123456789abc';
const child = (): Task => ({ id: '333333333333', title: 'child', prompt: 'x', repository: 'C:/repo', worktree: 'C:/work', branch: 'agent/child', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', delegation: { parentId: '111111111111', runId: '222222222222', childKey: 'child', dispatchKey: 'b'.repeat(24), dependencies: [] }, schedule: { state: 'enrolled', dependencies: [], artifacts: [] } });
function harness(task: Task, options: { persist?: () => Promise<void>; live?: () => number; budget?: () => string[]; reserve?: () => Promise<boolean>; launch?: () => Promise<void> } = {}) {
  let launches = 0, durable: Task | undefined;
  const scheduler = new TaskScheduler({ tasks: () => [task], capacity: () => 2, liveCount: options.live || (() => 0), enabled: () => true,
    persist: async () => { await options.persist?.(); durable = structuredClone(task); }, budget: options.budget,
    reserve: options.reserve, prepare: async () => ({ commit: task.baseCommit, artifacts: [] }),
    launch: async () => { assert.equal(durable?.delegationExecution?.status, 'starting'); launches++; await options.launch?.(); task.state = 'running'; }
  });
  return { scheduler, launches: () => launches, durable: () => durable };
}

test('only explicitly enrolled idle managed child is eligible', () => {
  assert.doesNotThrow(() => assertDelegatedManagedDispatch(child()));
  const queued = child(); queued.schedule!.state = 'queued'; assert.throws(() => assertDelegatedManagedDispatch(queued));
  const interactive = child(); interactive.interface = 'interactive-cli'; assert.throws(() => assertDelegatedManagedDispatch(interactive));
});

test('reservation binds execution inputs and one exact session acknowledgement', () => {
  const task = child(); task.delegationExecution = reserveDelegatedExecution(task); startDelegatedExecution(task);
  const acknowledged = acknowledgeDelegatedSession(task.delegationExecution, sessionId); assert.equal(acknowledged.status, 'sessioned');
  assert.deepEqual(acknowledgeDelegatedSession(acknowledged, sessionId), acknowledged);
  assert.throws(() => acknowledgeDelegatedSession(acknowledged, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  for (const key of ['worktree', 'baseCommit', 'provider', 'prompt'] as const) { const changed = structuredClone(task); (changed as any)[key] = 'changed'; assert.throws(() => validateDelegatedExecution(changed), /stale/); }
});

test('scheduler durably reserves before exactly one launch, including concurrent drains', async () => {
  const task = child(), h = harness(task); await h.scheduler.enqueue(task, { type: 'startManaged' });
  await Promise.all([h.scheduler.drain(), h.scheduler.drain()]); assert.equal(h.launches(), 1);
  await assert.rejects(h.scheduler.enqueue(task, { type: 'startManaged' }));
});

test('enqueue save failure restores enrollment and cannot drain an unsaved request', async () => {
  const task = child(), h = harness(task, { persist: async () => { throw Error('disk unavailable'); } });
  await assert.rejects(h.scheduler.enqueue(task, { type: 'startManaged' }), /disk unavailable/);
  assert.equal(task.schedule?.state, 'enrolled'); assert.equal(task.delegationExecution, undefined);
  await h.scheduler.drain(); assert.equal(h.launches(), 0);
});

test('dispatch-save failure never launches and retains an uncertain capacity hold', async () => {
  const task = child(), h = harness(task, { persist: async () => { if (task.delegationExecution?.status === 'starting') throw Error('dispatch save failed'); } });
  await assert.rejects(h.scheduler.enqueue(task, { type: 'startManaged' }), /dispatch save failed/);
  assert.equal(h.launches(), 0); assert.equal(task.schedule?.uncertain, true);
  await h.scheduler.drain(); assert.equal(h.launches(), 0);
});

test('capacity includes parent, profile refusal and stop prevent process dispatch', async () => {
  let live = 2; const task = child(), h = harness(task, { live: () => live });
  await h.scheduler.enqueue(task, { type: 'startManaged' }); assert.equal(h.launches(), 0); assert.equal(task.delegationExecution?.status, 'reserved');
  live = 1; await h.scheduler.drain(); assert.equal(h.launches(), 1);
  const stopped = child(), blocked = harness(stopped, { reserve: async () => false });
  await blocked.scheduler.enqueue(stopped, { type: 'startManaged' }); await blocked.scheduler.cancel(stopped); await blocked.scheduler.drain();
  assert.equal(blocked.launches(), 0); assert.equal(stopped.delegationExecution?.status, 'stopped');
});

test('restart never relaunches escaped dispatch; explicit reconciliation retains session binding', async () => {
  const task = child(), h = harness(task); await h.scheduler.enqueue(task, { type: 'startManaged' });
  const restored = structuredClone(h.durable()!); const next = harness(restored); next.scheduler.reconcile();
  assert.equal(restored.delegationExecution?.status, 'uncertain'); await next.scheduler.drain(); assert.equal(next.launches(), 0);
  await next.scheduler.reconcileStopped(restored); await assert.rejects(next.scheduler.enqueue(restored, { type: 'startManaged' })); assert.equal(next.launches(), 0);
});

test('session persistence failure retains escaped session and refuses optimistic completion', async () => {
  const task = child(); task.delegationExecution = reserveDelegatedExecution(task); startDelegatedExecution(task); task.sessionId = sessionId;
  await assert.rejects(recordDelegatedSession(task, sessionId, async () => { throw Error('receipt save failed'); }), /receipt save failed/);
  assert.equal(task.delegationExecution?.sessionId, sessionId); assert.equal(task.delegationExecution?.status, 'uncertain'); assert.equal(task.schedule?.uncertain, true);
});

test('non-managed requests and failed prerequisites never launch delegated children', async () => {
  const terminal = child(), h = harness(terminal); await assert.rejects(h.scheduler.enqueue(terminal, { type: 'terminal' }), /managed/); assert.equal(terminal.delegationExecution, undefined);
  const task = child(); task.delegation!.dependencies = ['444444444444']; task.schedule!.dependencies = ['444444444444'];
  const blocked = harness(task); await blocked.scheduler.enqueue(task, { type: 'startManaged' }); assert.equal(blocked.launches(), 0); assert.equal(task.schedule?.state, 'blocked');
});

test('budget hold retains reservation and requires explicit retry', async () => {
  let held = true; const task = child(), h = harness(task, { budget: () => { if (held) throw new BudgetHoldError(['Task budget reached']); return []; } });
  await h.scheduler.enqueue(task, { type: 'startManaged' }); assert.equal(h.launches(), 0); assert.equal(task.schedule?.budgetHold, true); assert.equal(task.delegationExecution?.status, 'reserved');
  held = false; await h.scheduler.drain(); assert.equal(h.launches(), 0);
  await h.scheduler.retryBudgetHold(task); assert.equal(h.launches(), 1);
});

test('task store round trip validates dispatch binding and rejects tampered receipt', async () => {
  const base = path.resolve('.test-build/delegation-runner'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'store-'));
  try {
    const task = child(); task.repository = root; task.worktree = root;
    task.delegationExecution = reserveDelegatedExecution(task); const store = new LocalStore(root);
    await store.save([task]); assert.deepEqual((await store.load())[0]?.delegationExecution, task.delegationExecution);
    task.delegationExecution.dispatchKey = 'c'.repeat(24);
    await writeFile(path.join(root, 'tasks.json'), JSON.stringify({ version: 1, tasks: [task] }));
    await assert.rejects(store.load(), /Invalid or stale delegated execution/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stop during starting receipt persistence prevents launch after save resolves', async () => {
  const task = child(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(task, { persist: async () => { if (task.delegationExecution?.status === 'starting') { entered(); await gate; } } });
  const enqueuing = h.scheduler.enqueue(task, { type: 'startManaged' }); await waiting;
  await h.scheduler.cancel(task); release(); await enqueuing;
  assert.equal(h.launches(), 0); assert.equal(task.schedule?.state, 'cancelled'); assert.equal(task.delegationExecution?.status, 'stopped');
});
