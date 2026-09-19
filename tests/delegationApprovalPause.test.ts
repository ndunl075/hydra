import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureDelegationApprovalPauses } from '../src/core/delegationApprovalPause';
import { LocalStore } from '../src/core/store';
import { DelegationHandoffHost } from '../src/core/delegationHandoffHost';
import { DelegationHandoffProducer } from '../src/core/delegationHandoffProducer';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import type { Task } from '../src/core/model';

const parentId = '1'.repeat(12), runId = '2'.repeat(12), taskId = '3'.repeat(12), dispatchKey = '4'.repeat(24), now = '2026-09-19T00:00:00.000Z';
const child = (directory: string): Task => ({ id: taskId, title: 'Child', prompt: 'fixture', repository: directory, worktree: directory, branch: 'agent/child', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'running', createdAt: now, updatedAt: now, delegation: { parentId, runId, childKey: 'child', dispatchKey, dependencies: [] }, schedule: { state: 'waiting-for-approval', dependencies: [], artifacts: [], request: { type: 'startManaged' } } });

test('one opaque approval pause survives task restart and produces one recoverable graph fact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-approval-pause-'));
  try {
    const task = child(directory), store = new LocalStore(path.join(directory, 'tasks'));
    assert.equal(captureDelegationApprovalPauses(task, [{ id: '5'.repeat(12), kind: 'command', detail: 'private provider message' }], '6'.repeat(12), now), true);
    assert.equal(captureDelegationApprovalPauses(task, [{ id: '5'.repeat(12), kind: 'command', detail: 'private provider message' }], '6'.repeat(12), now), false);
    assert.equal(JSON.stringify(task.delegationApprovalPauses).includes('private provider message'), false);
    await store.save([task]);
    const saved = (await new LocalStore(path.join(directory, 'tasks')).load())[0]!;
    const journal = new DelegationOrchestrationJournal(path.join(directory, 'journal'));
    const failing = new DelegationHandoffHost(new DelegationHandoffProducer({ load: journal.load.bind(journal), appendEvent: async () => { throw new Error('disk full'); } } as unknown as DelegationOrchestrationJournal));
    await assert.rejects(failing.paused(saved, saved.delegationApprovalPauses![0]!), /disk full/);
    assert.equal((await journal.load(parentId, runId)).events.length, 0);
    const recovered = new DelegationHandoffHost(new DelegationHandoffProducer(new DelegationOrchestrationJournal(path.join(directory, 'journal'))));
    const event = await recovered.paused(saved, saved.delegationApprovalPauses![0]!);
    assert.equal(event.kind, 'approval-pause');
    assert.equal(event.occurredAt, now);
    assert.equal((await recovered.paused(saved, saved.delegationApprovalPauses![0]!)).sequence, event.sequence);
    assert.throws(() => recovered.paused(saved, { ...saved.delegationApprovalPauses![0]!, occurredAt: '2026-09-19T00:00:01.000Z' }), /exact saved task source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('navigation and non-waiting task state create no pause source', () => {
  const task = child(tmpdir());
  task.schedule!.state = 'running';
  assert.equal(captureDelegationApprovalPauses(task, [{ id: '5'.repeat(12), kind: 'command', detail: 'private' }], '6'.repeat(12), now), false);
  assert.equal(task.delegationApprovalPauses, undefined);
});
