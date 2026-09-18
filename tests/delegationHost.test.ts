import test from 'node:test';
import assert from 'node:assert/strict';
import { hostDelegationPolicy } from '../src/core/delegationHost';
import type { Task } from '../src/core/model';

const base = 'a'.repeat(40), parentId = '123456789abc', runId = 'abcdef123456';
const parent = { id: parentId, baseCommit: base, provider: 'claude', modelSelection: { model: 'fixture', effort: 'medium' } } as Task;
const proposal = { version: 1, id: '0123456789ab', parentId, runId, decision: 'delegate', rationale: 'Independent work', children: [{ key: 'ui', goal: 'Update UI', deliverable: 'A reviewed commit', baseCommit: base, writeScope: ['webview/'], dependencies: [], acceptance: ['Tests pass'], testCommands: ['npm test'], contextRefs: [], provider: 'claude', modelSelection: { model: 'fixture', effort: 'medium' } }] };
const policy = { parentId, runId, mode: 'auto', level: 0, maxChildren: 2, provider: 'claude', modelSelection: { model: 'fixture', effort: 'medium' }, models: [], approvedBases: [base], writeScope: ['webview/'], otherOwners: [], context: { userIntent: 'Update UI', qualityTarget: 'Passing tests', constraints: ['Keep scope'], instructions: [], interfaces: [], evidence: [], maxTurns: 2, timeoutMs: 300000 } };

test('host delegation gate binds a proposal to its parent task and saved limits', () => {
  assert.equal(hostDelegationPolicy(proposal, policy, parent, { mode: 'auto', maxChildren: 2, status: 'preparation' }).proposal.id, proposal.id);
  assert.throws(() => hostDelegationPolicy(proposal, { ...policy, mode: 'solo' }, parent, { mode: 'auto', maxChildren: 2, status: 'preparation' }), /current Hydra preference/);
  assert.throws(() => hostDelegationPolicy({ ...proposal, children: [{ ...proposal.children[0], baseCommit: 'b'.repeat(40) }] }, policy, parent, { mode: 'auto', maxChildren: 2, status: 'preparation' }), /recorded base commit/);
  assert.throws(() => hostDelegationPolicy(proposal, { ...policy, provider: 'codex' }, parent, { mode: 'auto', maxChildren: 2, status: 'preparation' }), /parent execution boundary/);
});
