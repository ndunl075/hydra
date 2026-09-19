import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionView, Task } from '../src/core/model';
import { pendingDelegationBudgetReservations, projectDelegationRunUsage, releaseDelegationBudget, reserveDelegationBudget } from '../src/core/delegationRunAccounting';

const parentId = '111111111111', runId = '222222222222';
const task = (id: string, childKey?: string): Task => ({
  id, title: childKey || 'parent', prompt: 'fixture', repository: 'C:/repo', worktree: `C:/work/${id}`, branch: `agent/${id}`,
  baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
  ...(childKey ? { delegation: { parentId, runId, childKey, dispatchKey: id.repeat(2), dependencies: [] }, schedule: { state: 'queued' as const, dependencies: [], artifacts: [], request: { type: 'startManaged' as const } } } : {})
});
const view = (input: number, session = '12345678-1234-7234-9234-123456789abc'): SessionView => ({ version: 1, turns: [{ id: 'aaaaaaaaaaaa', provider: 'codex', prompt: '', text: '', status: 'completed', createdAt: '2026-09-19T00:00:00.000Z', threadUsage: { sessionId: session, input, output: 2 } }] });

test('run usage projects parent, children and retry histories once while unknown stages remain unavailable', () => {
  const parent = task(parentId), child = task('333333333333', 'child'), retry = { ...task('444444444444', 'retry'), delegationRetry: { version: 1 as const, parentId, runId, dispatchKey: '444444444444444444444444', attemptedAt: '2026-09-19T00:00:00.000Z' } };
  const sessions: Record<string, SessionView | undefined> = { [parent.id]: view(10, '12345678-1234-7234-9234-123456789abc'), [child.id]: view(20, '22345678-1234-7234-9234-123456789abc'), [retry.id]: view(30, '32345678-1234-7234-9234-123456789abc') };
  const projection = projectDelegationRunUsage(parent, runId, [parent, child, retry], id => sessions[id]);
  assert.equal(projection.total.codex?.input, 60);
  assert.equal(projection.stages.planning.usage.codex?.input, 10);
  assert.equal(projection.stages.child.usage.codex?.input, 20);
  assert.equal(projection.stages.retry.usage.codex?.input, 30);
  assert.equal(projection.stages.review.coverage, 'unavailable');
  assert.equal(projection.stages.validation.coverage, 'unavailable');
  const resumed = projectDelegationRunUsage(parent, runId, [parent, child, retry], id => sessions[id]);
  assert.deepEqual(resumed, projection, 'Repeated projections do not turn cumulative snapshots into deltas');
});

test('shared cumulative provider session and missing history remain distinct and partial', () => {
  const parent = task(parentId), child = task('333333333333', 'child'), missing = task('444444444444', 'missing');
  const shared = '12345678-1234-7234-9234-123456789abc';
  const projection = projectDelegationRunUsage(parent, runId, [parent, child, missing], id => id === parent.id ? view(40, shared) : id === child.id ? view(60, shared) : undefined);
  assert.equal(projection.total.codex?.input, 60, 'Latest cumulative total wins even across parent/child views');
  assert.equal(projection.coverage, 'partial');
  assert.equal(projection.stages.child.coverage, 'partial');
});

test('a pending sibling guard blocks only a same-provider run and cancellation releases only its own reservation', () => {
  const parent = task(parentId), first = task('333333333333', 'one'), second = task('444444444444', 'two'), otherProvider = { ...task('555555555555', 'three'), provider: 'claude' as const };
  const all = [parent, first, second, otherProvider];
  reserveDelegationBudget(first, all, 'startManaged', '2026-09-19T00:00:00.000Z');
  assert.equal(pendingDelegationBudgetReservations(all, parentId, runId).length, 1);
  assert.throws(() => reserveDelegationBudget(second, all, 'startManaged'), /pending budget check/);
  assert.doesNotThrow(() => reserveDelegationBudget(otherProvider, all, 'startManaged'));
  assert.equal(releaseDelegationBudget(second), false, 'A sibling cannot release an absent or foreign reservation');
  assert.equal(releaseDelegationBudget(first), true);
  assert.doesNotThrow(() => reserveDelegationBudget(second, all, 'startManaged'));
});

test('finished receipt views do not remain blocked by an older reservation', () => {
  const parent = task(parentId), completed = task('333333333333', 'one'), next = task('444444444444', 'two'), all = [parent, completed, next];
  reserveDelegationBudget(completed, all, 'startManaged');
  completed.schedule = { state: 'finished', dependencies: [], artifacts: [] };
  assert.deepEqual(pendingDelegationBudgetReservations(all, parentId, runId), []);
  assert.doesNotThrow(() => reserveDelegationBudget(next, all, 'startManaged'));
});
