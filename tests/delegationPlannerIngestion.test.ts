import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDelegationPlannerTurn, createDelegationPlannerRun, ingestDelegationPlannerCompletion, plannerMarker } from '../src/core/delegationPlannerIngestion';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', turnId = '333333333333', base = 'a'.repeat(40);
const task = (): Task => ({ id: parentId, title: 'Parent', prompt: 'Implement feature', repository: 'C:\\repo', worktree: 'C:\\repo\\child', branch: 'agent/parent-111111111111', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const policy = () => ({ parentId, runId, mode: 'auto' as const, level: 0 as const, maxChildren: 2, provider: 'codex' as const, models: [], approvedBases: [base], writeScope: ['src/'], otherOwners: [], context: { userIntent: 'Implement feature', qualityTarget: 'Pass tests', constraints: ['Keep scope'], instructions: [], interfaces: [], evidence: [], maxTurns: 1, timeoutMs: 300000 } });
const preferences = { mode: 'auto' as const, maxChildren: 2, status: 'preparation' as const };
const proposal = (id = '444444444444') => ({ version: 1, id, parentId, runId, decision: 'solo', rationale: 'One small localized change.', children: [] });
const completed = (text: string) => ({ id: turnId, status: 'completed' as const, text });

test('records one explicit Solo proposal and duplicate completion does not record it twice', async () => {
  const value = task(); value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
  const calls: unknown[] = [], store = { recordDecision: async (input: unknown) => { calls.push(input); } };
  const output = `Normal answer\n${plannerMarker}${JSON.stringify(proposal())}`;
  const first = await ingestDelegationPlannerCompletion({ task: value, turn: completed(output), decisions: store });
  assert.equal(first?.state, 'accepted'); assert.equal(calls.length, 1);
  await ingestDelegationPlannerCompletion({ task: value, turn: completed(output), decisions: store });
  assert.equal(calls.length, 1);
});

test('refuses malformed or inferred output without recording a decision', async () => {
  const value = task(); value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
  let calls = 0;
  const result = await ingestDelegationPlannerCompletion({ task: value, turn: completed(JSON.stringify(proposal())), decisions: { recordDecision: async () => { calls++; } } });
  assert.equal(result?.state, 'rejected'); assert.equal(calls, 0);
});

test('rejects a completion from a different normal turn before it can touch storage', async () => {
  const value = task(); value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
  await assert.rejects(ingestDelegationPlannerCompletion({ task: value, turn: { id: '555555555555', status: 'completed', text: `${plannerMarker}${JSON.stringify(proposal())}` }, decisions: { recordDecision: async () => assert.fail('must not store') } }), /does not match/);
});

test('existing validators reject a bad base and retain a terminal planner rejection', async () => {
  const value = task(); value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
  const invalid = { ...proposal(), decision: 'delegate', children: [{ key: 'child', goal: 'Do it', deliverable: 'change', baseCommit: 'b'.repeat(40), writeScope: ['src/a'], dependencies: [], acceptance: ['test'], testCommands: [], contextRefs: [], provider: 'codex' }] };
  const result = await ingestDelegationPlannerCompletion({ task: value, turn: completed(`${plannerMarker}${JSON.stringify(invalid)}`), decisions: { recordDecision: async () => assert.fail('host binding must reject first') } });
  assert.equal(result?.state, 'rejected'); assert.match(result?.error || '', /base/i);
});

test('a decision-store failure remains submitted for restart replay and never fabricates rejection', async () => {
  const value = task(); value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
  await assert.rejects(ingestDelegationPlannerCompletion({ task: value, turn: completed(`${plannerMarker}${JSON.stringify(proposal())}`), decisions: { recordDecision: async () => { throw new Error('disk unavailable'); } } }), /disk unavailable/);
  assert.equal(value.delegationPlanner?.state, 'submitted');
});
