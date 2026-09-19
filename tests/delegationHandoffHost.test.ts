import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DelegationHandoffHost } from '../src/core/delegationHandoffHost';
import { DelegationHandoffProducer } from '../src/core/delegationHandoffProducer';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { prepareDelegationResult } from '../src/core/delegationResults';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', childId = '333333333333', now = '2026-09-19T00:00:00.000Z';
const child = (): Pick<Task, 'id' | 'delegation'> => ({ id: childId, delegation: { parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), dependencies: [] } });
const dispatch = () => ({ version: 1 as const, parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), worktreeId: 'c'.repeat(12), baseCommit: 'b'.repeat(40), status: 'materialized' as const, worktree: 'C:/fixture/child', branch: 'agent/parser-111111111111', createdAt: now, updatedAt: now });
const binding = () => ({ parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), baseCommit: 'b'.repeat(40), writeScope: ['src'], dependencies: [] });
const receipt = () => prepareDelegationResult({ version: 1, parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), baseCommit: 'b'.repeat(40), commit: 'c'.repeat(40), tree: 'd'.repeat(40), changedPaths: ['src/example.ts'], decisions: 'Kept the stable contract.', summary: 'Child completed its reviewed change.', unresolved: [], validations: [], evidence: [], dependencies: [] }, binding());

test('host adapter emits only from saved child, dispatch, and result records', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-handoff-host-'));
  try {
    const journal = new DelegationOrchestrationJournal(directory), host = new DelegationHandoffHost(new DelegationHandoffProducer(journal));
    await host.dispatched(dispatch(), child());
    const result = receipt(); await journal.appendResult(result, binding());
    await host.delivered(result, binding(), child(), '2026-09-19T00:00:01.000Z');
    assert.deepEqual((await journal.load(parentId, runId)).events.map(event => event.kind), ['dispatch', 'result-delivery']);
    assert.equal((await host.dispatched(dispatch(), child())).sequence, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host adapter refuses a task without a durable delegated identity', () => {
  const host = new DelegationHandoffHost({} as DelegationHandoffProducer);
  assert.throws(() => host.source({ id: childId }), /saved delegated child/);
});

test('a failed graph append retries after restart with the result journal timestamp', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-handoff-host-retry-'));
  try {
    const journal = new DelegationOrchestrationJournal(directory), result = receipt();
    const delivery = await journal.appendResultDelivery(result, binding());
    assert.ok(delivery.occurredAt);
    const failing = new DelegationHandoffHost(new DelegationHandoffProducer({ load: journal.load.bind(journal), appendEvent: async () => { throw new Error('disk full'); } } as unknown as DelegationOrchestrationJournal));
    await assert.rejects(failing.delivered(delivery.receipt, binding(), child(), delivery.occurredAt!), /disk full/);
    const restartedJournal = new DelegationOrchestrationJournal(directory);
    const replay = await restartedJournal.appendResultDelivery(result, binding());
    assert.equal(replay.occurredAt, delivery.occurredAt);
    const recovered = new DelegationHandoffHost(new DelegationHandoffProducer(restartedJournal));
    const event = await recovered.delivered(replay.receipt, binding(), child(), replay.occurredAt!);
    assert.equal(event.occurredAt, delivery.occurredAt);
    assert.equal((await recovered.delivered(replay.receipt, binding(), child(), replay.occurredAt!)).sequence, event.sequence);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
