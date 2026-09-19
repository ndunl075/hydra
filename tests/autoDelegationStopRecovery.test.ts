import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAutoDelegationStopRecoveryIntent } from '../src/core/autoDelegationStopRecovery';
import { projectDelegationReconciliation } from '../src/core/delegationReconciliation';
import type { DelegationDispatch } from '../src/core/delegationDispatch';
import type { Task } from '../src/core/model';

const now = '2026-09-19T00:00:00.000Z', base = 'a'.repeat(40), parentId = '111111111111', runId = '222222222222';
const parent = (): Task => ({ id: parentId, title: 'Parent', prompt: 'x', repository: 'C:/repo', worktree: 'C:/parent', branch: 'agent/parent', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now });
const child = (id: string, key: string): Task => ({ id, title: key, prompt: 'x', repository: 'C:/repo', worktree: `C:/${key}`, branch: `agent/${key}-123456789abc`, baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now, delegation: { parentId, runId, childKey: key, dispatchKey: key === 'one' ? 'a'.repeat(24) : 'b'.repeat(24), dependencies: [] } });
const dispatch = (key: string, status: DelegationDispatch['status']): DelegationDispatch => ({ version: 1, parentId, runId, childKey: key, dispatchKey: key === 'one' ? 'a'.repeat(24) : 'b'.repeat(24), worktreeId: key === 'one' ? '333333333333' : '444444444444', baseCommit: base, status, createdAt: now, updatedAt: now, ...(status === 'materialized' ? { worktree: `C:/${key}`, branch: `agent/${key}-${key === 'one' ? '333333333333' : '444444444444'}` } : {}) });
const intent = (p: Task, children: Task[], dispatches: DelegationDispatch[], ownership: Parameters<typeof deriveAutoDelegationStopRecoveryIntent>[0]['ownership'] = []) => deriveAutoDelegationStopRecoveryIntent({ parent: p, runId, tasks: [p, ...children], reconciliation: projectDelegationReconciliation(p, runId, [p, ...children], dispatches), ownership });

test('pending durable dispatches become cancellation intents without mutating a child or launching it', () => {
  const p = parent(), one = child('333333333333', 'one'); one.schedule = { state: 'queued', dependencies: [], artifacts: [], request: { type: 'startManaged' } };
  const result = intent(p, [one], [dispatch('one', 'reserved')], [{ taskId: one.id, ownership: 'owned' }]);
  assert.equal(result.children[0]!.action, 'cancel-pending-dispatch');
  assert.equal(one.schedule.state, 'queued');
});

test('an active writer owned by this window requires an explicit stop rather than process termination', () => {
  const p = parent(), one = child('333333333333', 'one'); one.state = 'running'; one.schedule = { state: 'running', dependencies: [], artifacts: [] };
  const result = intent(p, [one], [dispatch('one', 'materialized')], [{ taskId: one.id, ownership: 'owned' }]);
  assert.equal(result.children[0]!.action, 'stop-owned-writer');
  assert.equal(one.state, 'running');
});

test('restart uncertainty remains held even when the previous writer was owned', () => {
  const p = parent(), one = child('333333333333', 'one'); one.schedule = { state: 'interrupted', dependencies: [], artifacts: [], uncertain: true }; one.delegationExecution = { version: 1, dispatchKey: one.delegation!.dispatchKey, binding: 'durable-binding', status: 'uncertain', createdAt: now, updatedAt: now };
  const result = intent(p, [one], [dispatch('one', 'materialized')], [{ taskId: one.id, ownership: 'owned' }]);
  assert.equal(result.children[0]!.action, 'hold-uncertain-writer');
  assert.match(result.children[0]!.reason, /Do not retry/);
});

test('old reviewed results never become a launch intent', () => {
  const p = parent(), one = child('333333333333', 'one'); one.reviewedCommit = { commit: 'b'.repeat(40), tree: 'c'.repeat(40), baseCommit: base, reviewedAt: now };
  const result = intent(p, [one], [dispatch('one', 'materialized')]);
  assert.equal(result.parent.action, 'none');
  assert.equal(result.children[0]!.action, 'none');
  assert.ok(!JSON.stringify(result).includes('launch'));
});

test('unowned and unknown active writers remain held, and incomplete reconciliation facts refuse', () => {
  const p = parent(), one = child('333333333333', 'one'); p.state = 'running'; one.state = 'running'; one.schedule = { state: 'running', dependencies: [], artifacts: [] };
  const result = intent(p, [one], [dispatch('one', 'materialized')], [{ taskId: p.id, ownership: 'unowned' }]);
  assert.equal(result.parent.action, 'hold-unowned-writer');
  assert.equal(result.children[0]!.action, 'hold-unowned-writer');
  assert.throws(() => deriveAutoDelegationStopRecoveryIntent({ parent: p, runId, tasks: [p, one], reconciliation: { parentId, runId, availability: 'available', journal: 'available', children: [] }, ownership: [] }), /complete direct-child/);
});
