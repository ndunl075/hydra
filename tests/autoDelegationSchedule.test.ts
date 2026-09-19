import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoDelegationScheduleIntents } from '../src/core/autoDelegationSchedule';
import { prepareDelegation, type DelegationChild, type DelegationPolicy, type DelegationProposal } from '../src/core/delegationPlan';
import type { DelegationDispatch } from '../src/core/delegationDispatch';

const parentId = '123456789abc', runId = 'abcdef123456', base = 'a'.repeat(40), now = '2026-09-19T12:00:00.000Z';

function child(key: string, dependencies: string[] = []): DelegationChild {
  return { key, goal: `Implement ${key}`, deliverable: 'Reviewed change', baseCommit: base, writeScope: [`src/${key}.ts`], dependencies, acceptance: ['Focused test passes'], testCommands: ['npm test'], contextRefs: ['source'], provider: 'claude' };
}
function policy(): DelegationPolicy {
  return { parentId, runId, mode: 'auto', level: 0, maxChildren: 8, provider: 'claude', models: [], approvedBases: [base], writeScope: ['src/'], otherOwners: [], context: { userIntent: 'Implement independent children', qualityTarget: 'A verified result', constraints: ['Use only the assigned worktree'], instructions: [{ id: 'agents', path: 'AGENTS.md', revision: base, content: 'Address Nico.', reason: 'Repository instruction' }], interfaces: [], evidence: [{ id: 'source', path: 'src/source.ts', revision: base, content: 'export {};', reason: 'Relevant source' }], maxTurns: 2, timeoutMs: 300000 } };
}
function prepared(children: DelegationChild[]) {
  const proposal: DelegationProposal = { version: 1, id: '0123456789ab', parentId, runId, decision: 'delegate', rationale: 'Independent scopes', children };
  return prepareDelegation(proposal, policy());
}
function dispatch(childKey: string, id: string, status: DelegationDispatch['status'] = 'materialized'): DelegationDispatch {
  return { version: 1, parentId, runId, childKey, dispatchKey: id.repeat(2), worktreeId: id, baseCommit: base, status, createdAt: now, updatedAt: now, ...(status === 'materialized' ? { worktree: `C:\\worktrees\\${id}`, branch: `agent/${childKey}-${id}` } : {}) };
}

test('independent validated children produce ready managed intents together', () => {
  const result = createAutoDelegationScheduleIntents([prepared([child('first'), child('second')])], [dispatch('first', '111111111111'), dispatch('second', '222222222222')]);
  assert.deepEqual(result, [
    { version: 1, childId: '111111111111', dispatchKey: '111111111111111111111111', parentId, runId, childKey: 'first', baseCommit: base, predecessorIds: [], state: 'ready', request: { type: 'startManaged' } },
    { version: 1, childId: '222222222222', dispatchKey: '222222222222222222222222', parentId, runId, childKey: 'second', baseCommit: base, predecessorIds: [], state: 'ready', request: { type: 'startManaged' } }
  ]);
});

test('a dependent child waits for its durable predecessor identity', () => {
  const result = createAutoDelegationScheduleIntents([prepared([child('first'), child('second', ['first'])])], [dispatch('first', '111111111111'), dispatch('second', '222222222222')]);
  assert.equal(result[0]!.state, 'ready');
  assert.deepEqual(result[1], { version: 1, childId: '222222222222', dispatchKey: '222222222222222222222222', parentId, runId, childKey: 'second', baseCommit: base, predecessorIds: ['111111111111'], state: 'waiting-for-predecessors', request: { type: 'startManaged' } });
});

test('replaying the same prepared decision and dispatch receipts produces the same intents', () => {
  const decision = prepared([child('first'), child('second', ['first'])]);
  const dispatches = [dispatch('first', '111111111111'), dispatch('second', '222222222222')];
  assert.deepEqual(createAutoDelegationScheduleIntents([decision], dispatches), createAutoDelegationScheduleIntents([decision], structuredClone(dispatches)));
});

test('duplicate materialized worktree receipts refuse before an intent can be projected', () => {
  const decision = prepared([child('first'), child('second')]);
  const firstReceipt = dispatch('first', '111111111111');
  const secondReceipt = { ...dispatch('second', '222222222222'), worktreeId: firstReceipt.worktreeId };
  assert.throws(
    () => createAutoDelegationScheduleIntents([decision], [firstReceipt, secondReceipt]),
    /one saved dispatch identity per child/
  );
});

test('cancelled or uncertain dispatches refuse before an intent can be projected', () => {
  const decision = prepared([child('first')]);
  for (const status of ['reserved', 'uncertain'] as const) {
    assert.throws(() => createAutoDelegationScheduleIntents([decision], [dispatch('first', '111111111111', status)]), /cancelled, uncertain, or does not match/);
  }
});
