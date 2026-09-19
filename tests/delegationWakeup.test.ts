import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../src/core/model';
import { TaskScheduler } from '../src/core/scheduler';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { DelegationWakeup } from '../src/core/delegationWakeup';
import { prepareDelegationResult } from '../src/core/delegationResults';
import { LocalStore } from '../src/core/store';

const now = '2026-09-19T00:00:00.000Z', base = 'a'.repeat(40), parentId = '111111111111', runId = '222222222222';
const parent = (): Task => ({ id: parentId, title: 'Parent', prompt: 'Parent prompt', repository: path.resolve('fixture'), worktree: path.resolve('fixture-parent'), branch: 'agent/parent', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'running', sessionId: '11111111-1111-4111-8111-111111111111', sessionProvider: 'codex', createdAt: now, updatedAt: now, schedule: { state: 'running', dependencies: [], artifacts: [], request: { type: 'startManaged' } } });
const child = (n: number): Task => ({ id: n.toString(16).padStart(12, '0'), title: `Child ${n}`, prompt: 'Child prompt', repository: path.resolve('fixture'), worktree: path.resolve(`fixture-child-${n}`), branch: `agent/child-${n}`, baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now, delegation: { parentId, runId, childKey: `child-${n}`, dispatchKey: n.toString(16).padStart(24, '0'), dependencies: [] }, schedule: { state: 'finished', dependencies: [], artifacts: [] } });
const binding = (item: Task) => ({ parentId, runId, childKey: item.delegation!.childKey, dispatchKey: item.delegation!.dispatchKey, baseCommit: base, writeScope: ['src'], dependencies: [] });
const receipt = (item: Task) => prepareDelegationResult({ version: 1, parentId, runId, childKey: item.delegation!.childKey, dispatchKey: item.delegation!.dispatchKey, baseCommit: base, commit: 'b'.repeat(40), tree: 'c'.repeat(40), changedPaths: ['src/example.ts'], decisions: 'Kept the contract.', summary: `${item.title} completed.`, unresolved: [], validations: [], evidence: [], dependencies: [] }, binding(item));
function scheduler(tasks: Task[], persist: () => Promise<void>) { return new TaskScheduler({ tasks: () => tasks, capacity: () => 2, liveCount: () => 0, enabled: () => false, persist, prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async () => assert.fail('No provider launch belongs to wakeup delivery.') }); }

test('suspension releases the scheduler state while preserving the durable provider session', async () => {
  const item = parent(), journal = new DelegationOrchestrationJournal(await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'))); let released = 0, saved = 0;
  const wakeup = new DelegationWakeup(journal, scheduler([item], async () => { saved++; }), async () => { saved++; });
  await wakeup.suspend(item, { parentId, runId, childIds: [child(1).id] }, async () => { released++; });
  assert.equal(released, 1); assert.equal(item.sessionId, '11111111-1111-4111-8111-111111111111'); assert.equal(item.schedule?.state, 'waiting-for-children'); assert.equal(item.schedule?.request, undefined); assert.equal(item.state, 'idle'); assert.ok(saved > 0);
});

test('suspension saves a detached waiting candidate before release and compensates a release failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'));
  try {
    const item = parent(), journal = new DelegationOrchestrationJournal(directory), saved: Task[] = [];
    const wakeup = new DelegationWakeup(journal, scheduler([item], async () => {}), async candidate => { saved.push(structuredClone(candidate!)); });
    await assert.rejects(wakeup.suspend(item, { parentId, runId, childIds: [child(1).id] }, async () => { throw Error('stop failed'); }), /stop failed/);
    assert.deepEqual(saved.map(task => task.schedule?.state), ['waiting-for-children', 'running']);
    assert.equal(item.schedule?.state, 'running'); assert.equal(item.state, 'running');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('suspension never releases a session when persisting the waiting candidate fails', async () => {
  const item = parent(), journal = new DelegationOrchestrationJournal(await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'))); let released = 0;
  const wakeup = new DelegationWakeup(journal, scheduler([item], async () => {}), async () => { throw Error('disk full'); });
  await assert.rejects(wakeup.suspend(item, { parentId, runId, childIds: [child(1).id] }, async () => { released++; }), /disk full/);
  assert.equal(released, 0); assert.equal(item.schedule?.state, 'running'); assert.equal(item.state, 'running');
});

test('simultaneous durable child receipts coalesce into one restart-safe scheduler wakeup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'));
  try {
    const item = parent(), first = child(1), second = child(2), journal = new DelegationOrchestrationJournal(directory); let saves = 0;
    const wakeup = new DelegationWakeup(journal, scheduler([item, first, second], async () => { saves++; }), async () => { saves++; });
    await wakeup.suspend(item, { parentId, runId, childIds: [first.id, second.id] }, async () => {});
    await Promise.all([wakeup.receive(receipt(first), binding(first)), wakeup.receive(receipt(second), binding(second))]);
    const result = await wakeup.reconcile(item, runId, [first, second]);
    assert.equal(result.state, 'woken'); assert.equal(item.schedule?.state, 'queued'); assert.ok(item.schedule?.wakeupKey); assert.match((item.schedule?.request as { prompt: string }).prompt, /Child 1 completed/); assert.match((item.schedule?.request as { prompt: string }).prompt, /Child 2 completed/);
    const reloaded = new DelegationWakeup(new DelegationOrchestrationJournal(directory), scheduler([item, first, second], async () => { throw Error('Restart tried to persist another wakeup'); }), async () => { throw Error('Restart tried to persist another wakeup'); });
    assert.deepEqual(await reloaded.reconcile(item, runId, [first, second]), { state: 'woken', wakeupKey: item.schedule!.wakeupKey }); assert.equal(saves > 0, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed prerequisite blocks a parent without losing a useful sibling receipt, and cancellation prevents wakeup', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'));
  try {
    const item = parent(), good = child(1), failed = child(2), journal = new DelegationOrchestrationJournal(directory); const wakeup = new DelegationWakeup(journal, scheduler([item, good, failed], async () => {}), async () => {});
    await wakeup.suspend(item, { parentId, runId, childIds: [good.id, failed.id] }, async () => {});
    await wakeup.receive(receipt(good), binding(good));
    failed.state = 'error'; assert.equal((await wakeup.reconcile(item, runId, [good, failed])).state, 'blocked'); assert.equal((await journal.load(parentId, runId)).results.length, 1);
    item.schedule = { state: 'waiting-for-children', dependencies: [], artifacts: [] }; item.state = 'idle';
    const cancelling = scheduler([item], async () => {}); await cancelling.cancel(item);
    assert.equal((await wakeup.reconcile(item, runId, [good, failed])).state, 'cancelled');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('blocked reconciliation persists a detached candidate and leaves the live parent waiting if saving fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'));
  try {
    const item = parent(), failed = child(1); item.state = 'idle'; item.schedule = { state: 'waiting-for-children', dependencies: [], artifacts: [] }; failed.state = 'error';
    const wakeup = new DelegationWakeup(new DelegationOrchestrationJournal(directory), scheduler([item, failed], async () => {}), async candidate => { assert.equal(candidate?.schedule?.state, 'blocked'); throw Error('disk full'); });
    await assert.rejects(wakeup.reconcile(item, runId, [failed]), /disk full/);
    assert.equal(item.schedule?.state, 'waiting-for-children');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one retry is persisted before scheduler retry and cannot be reset in memory', async () => {
  const item = child(1), journal = new DelegationOrchestrationJournal(await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'))); let persisted = 0, retried = 0;
  const wakeup = new DelegationWakeup(journal, scheduler([item], async () => {}), async () => { persisted++; });
  await wakeup.retryChildOnce(item, async () => { retried++; });
  assert.equal(persisted, 1); assert.equal(retried, 1); await assert.rejects(wakeup.retryChildOnce(item, async () => {}), /one automatic retry/);
});

test('task store rejects a waiting parent with no recorded managed session identity/provider', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-wakeup-'));
  try {
    const item = parent(); item.state = 'idle'; item.schedule = { state: 'waiting-for-children', dependencies: [], artifacts: [] }; item.sessionId = undefined;
    await writeFile(path.join(directory, 'tasks.json'), JSON.stringify({ version: 1, tasks: [item] }));
    await assert.rejects(new LocalStore(directory).load(), /Waiting parent requires/);
    item.sessionId = '11111111-1111-4111-8111-111111111111'; item.sessionProvider = 'claude';
    await writeFile(path.join(directory, 'tasks.json'), JSON.stringify({ version: 1, tasks: [item] }));
    await assert.rejects(new LocalStore(directory).load(), /Waiting parent requires/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
