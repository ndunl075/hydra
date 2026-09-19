import test from 'node:test';
import assert from 'node:assert/strict';
import { admitAutoDelegation } from '../src/core/autoDelegationAdmission';
import type { DelegationChild, DelegationPolicy, DelegationProposal } from '../src/core/delegationPlan';
import type { DelegationPreferences } from '../src/core/delegationPreferences';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', base = 'a'.repeat(40);
const preferences = (mode: 'solo' | 'auto' = 'auto'): DelegationPreferences => ({ mode, maxChildren: 2, status: 'preparation' });
const parent = (): Task => ({ id: parentId, title: 'Parent', prompt: 'Implement feature', repository: 'C:\\repo', worktree: 'C:\\repo\\parent', branch: 'agent/parent-111111111111', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const policy = (mode: 'solo' | 'auto' = 'auto'): DelegationPolicy => ({ parentId, runId, mode, level: 0, maxChildren: 2, provider: 'codex', models: [], approvedBases: [base], writeScope: ['src/', 'tests/'], otherOwners: ['webview/'], context: { userIntent: 'Implement feature', qualityTarget: 'Pass tests', constraints: ['Keep the assigned scope'], instructions: [], interfaces: [], evidence: [], maxTurns: 1, timeoutMs: 300000 } });
const child = (key: string, writeScope: string[]): DelegationChild => ({ key, goal: `Implement ${key}`, deliverable: 'Reviewed change', baseCommit: base, writeScope, dependencies: [], acceptance: ['Related test passes'], testCommands: ['npm test'], contextRefs: [], provider: 'codex' });
const proposal = (children: DelegationChild[] = [child('source', ['src/feature.ts']), child('tests', ['tests/feature.test.ts'])]): DelegationProposal => ({ version: 1, id: '333333333333', parentId, runId, decision: children.length ? 'delegate' : 'solo', rationale: children.length ? 'Independent source and test ownership.' : 'One localized change.', children });

test('localized and ambiguous work remain solo only when the saved proposal says solo', () => {
  const localized = proposal([]);
  assert.deepEqual(admitAutoDelegation({ proposal: localized, policy: policy(), parent: parent(), preferences: preferences() }), { status: 'solo', rationale: 'One localized change.' });
  const ambiguous = { ...localized, rationale: 'One unresolved root cause; investigate before splitting.' };
  assert.equal(admitAutoDelegation({ proposal: ambiguous, policy: policy(), parent: parent(), preferences: preferences() }).status, 'solo');
});

test('an exact valid independent proposal is eligible without creating anything', () => {
  const result = admitAutoDelegation({ proposal: proposal(), policy: policy(), parent: parent(), preferences: preferences() });
  assert.equal(result.status, 'eligible');
  assert.equal(result.rationale, 'Independent source and test ownership.');
  if (result.status === 'eligible') assert.deepEqual(result.proposal.children.map(item => item.key), ['source', 'tests']);
});

test('saved Solo preference keeps a delegate proposal with the parent', () => {
  const result = admitAutoDelegation({ proposal: proposal(), policy: policy('solo'), parent: parent(), preferences: preferences('solo') });
  assert.equal(result.status, 'solo');
  assert.match(result.rationale, /Solo/i);
});

test('overlapping scopes, dependency cycles, and stale bases block admission', () => {
  const overlapping = proposal([child('one', ['src/feature.ts']), child('two', ['src/feature.ts'])]);
  assert.deepEqual(admitAutoDelegation({ proposal: overlapping, policy: policy(), parent: parent(), preferences: preferences() }), { status: 'blocked', rationale: 'Child write scopes overlap and require one owner.' });
  const cycle = proposal(); cycle.children[0]!.dependencies = ['tests']; cycle.children[1]!.dependencies = ['source'];
  assert.equal(admitAutoDelegation({ proposal: cycle, policy: policy(), parent: parent(), preferences: preferences() }).status, 'blocked');
  const stale = proposal(); stale.children[0]!.baseCommit = 'b'.repeat(40);
  const staleResult = admitAutoDelegation({ proposal: stale, policy: policy(), parent: parent(), preferences: preferences() });
  assert.equal(staleResult.status, 'blocked');
  assert.match(staleResult.rationale, /base/i);
});
