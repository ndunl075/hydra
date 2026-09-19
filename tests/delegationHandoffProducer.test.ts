import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DelegationHandoffProducer } from '../src/core/delegationHandoffProducer';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { prepareDelegationResult } from '../src/core/delegationResults';

const parentId = '111111111111', runId = '222222222222', taskId = '333333333333', now = '2026-09-19T00:00:00.000Z';
const source = () => ({ parentId, runId, taskId, childKey: 'parser', dispatchKey: 'a'.repeat(24) });
const binding = () => ({ parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), baseCommit: 'b'.repeat(40), writeScope: ['src'], dependencies: [] });
const dispatch = () => ({ version: 1 as const, parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), worktreeId: 'c'.repeat(12), baseCommit: 'b'.repeat(40), status: 'materialized' as const, worktree: 'C:/fixture/child', branch: 'agent/parser-111111111111', createdAt: now, updatedAt: now });
const result = () => prepareDelegationResult({ version: 1, parentId, runId, childKey: 'parser', dispatchKey: 'a'.repeat(24), baseCommit: 'b'.repeat(40), commit: 'c'.repeat(40), tree: 'd'.repeat(40), changedPaths: ['src/example.ts'], decisions: 'Kept the stable contract.', summary: 'Child completed its reviewed change.', unresolved: [], validations: [], evidence: [], dependencies: [] }, binding());
async function fixture() { const directory = await mkdtemp(path.join(tmpdir(), 'hydra-handoff-producer-')); const journal = new DelegationOrchestrationJournal(directory); return { directory, journal, producer: new DelegationHandoffProducer(journal) }; }

test('emits durable dispatch, result, and approval facts once with journal-owned sequence order', async () => {
  const f = await fixture(); try {
    const first = await f.producer.dispatched(dispatch(), source());
    assert.equal(first.kind, 'dispatch'); assert.equal(first.sequence, 1); assert.equal(first.provenance.recordId, source().dispatchKey);
    assert.equal((await f.producer.dispatched(dispatch(), source())).id, first.id);
    const receipt = result(); await f.journal.appendResult(receipt, binding());
    const delivered = await f.producer.delivered(receipt, binding(), source(), '2026-09-19T00:00:01.000Z');
    const pause = { ...source(), recordId: 'e'.repeat(24), occurredAt: '2026-09-19T00:00:02.000Z', state: 'waiting-for-approval' as const };
    const paused = await f.producer.pausedAfterApproval(source(), pause);
    assert.deepEqual((await f.journal.load(parentId, runId)).events.map(event => [event.kind, event.sequence]), [['dispatch', 1], ['result-delivery', 2], ['approval-pause', 3]]);
    assert.equal(delivered.from.kind, 'task'); assert.equal(paused.to.kind, 'task');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('refuses non-durable, cross-run, and mismatched sources without phantom arrows', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.producer.dispatched({ ...dispatch(), status: 'reserved' }, source()), /Materialized dispatch/);
    await assert.rejects(f.producer.dispatched({ ...dispatch(), runId: '444444444444' }, source()), /exact delegated child/);
    const receipt = result();
    await assert.rejects(f.producer.delivered(receipt, binding(), source(), now), /exact durable journal receipt/);
    await assert.rejects(f.producer.pausedAfterApproval(source(), { ...source(), recordId: 'e'.repeat(24), occurredAt: now, state: 'idle' as any }), /waiting-for-approval/);
    await assert.rejects(f.producer.pausedAfterApproval(source(), { ...source(), taskId: '444444444444', recordId: 'e'.repeat(24), occurredAt: now, state: 'waiting-for-approval' }), /exact delegated child/);
    assert.deepEqual((await f.journal.load(parentId, runId)).events, []);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('a reused graph identity with altered durable source bytes is a conflict, not a no-op', async () => {
  const f = await fixture(); try {
    await f.producer.dispatched(dispatch(), source());
    await assert.rejects(f.producer.dispatched({ ...dispatch(), updatedAt: '2026-09-19T00:00:01.000Z' }, source()), /Conflicting durable handoff event identity/);
    assert.equal((await f.journal.load(parentId, runId)).events.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('journal failure leaves a dispatch source intact for recovery and navigation produces no event', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-handoff-producer-'));
  try {
    const original = dispatch(); const retained = structuredClone(original);
    const failing = new DelegationHandoffProducer(new DelegationOrchestrationJournal(directory, async () => { throw new Error('disk full'); }));
    await assert.rejects(failing.dispatched(original, source()), /disk full/);
    assert.deepEqual(original, retained);
    assert.deepEqual((await new DelegationOrchestrationJournal(directory).load(parentId, runId)).events, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
