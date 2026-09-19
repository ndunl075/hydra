import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDelegationPlannerTurn, createDelegationPlannerRun, ingestDelegationPlannerCompletion, plannerMarker, plannerPromptSuffix } from '../src/core/delegationPlannerIngestion';
import type { Task } from '../src/core/model';
import { DelegationStore } from '../src/core/delegationStore';
import { LocalStore } from '../src/core/store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

test('the normal-turn suffix supplies actual host IDs and a Solo shape without a second turn', () => {
  const run = createDelegationPlannerRun(policy(), preferences, runId);
  const prompt = plannerPromptSuffix(run);
  assert.match(prompt, new RegExp(parentId));
  assert.match(prompt, new RegExp(base));
  assert.match(prompt, /"decision":"solo"/);
  assert.match(prompt, /HYDRA_DELEGATION_V1:/);
});

test('accepted normal-turn choice and rationale survive task and decision-store reload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-parent-decision-'));
  try {
    const value = task(), tasks = new LocalStore(path.join(directory, 'tasks'));
    const decisions = new DelegationStore(path.join(directory, 'decisions'), async () => {});
    value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
    await tasks.save([value]);
    const output = completed(`${plannerMarker}${JSON.stringify(proposal())}`);
    await ingestDelegationPlannerCompletion({ task: value, turn: output, decisions });
    await tasks.save([value]);
    const reloaded = (await new LocalStore(path.join(directory, 'tasks')).load())[0]!;
    const saved = await new DelegationStore(path.join(directory, 'decisions'), async () => {}).load(parentId, runId);
    assert.equal(reloaded.delegationPlanner?.state, 'accepted');
    assert.equal(saved.decisions.length, 1);
    assert.equal(saved.decisions[0]?.proposal.decision, 'solo');
    assert.equal(saved.decisions[0]?.proposal.rationale, 'One small localized change.');
    await ingestDelegationPlannerCompletion({ task: reloaded, turn: output, decisions });
    assert.equal((await decisions.load(parentId, runId)).decisions.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an Auto split is saved with its rationale but never creates child tasks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-auto-decision-'));
  try {
    const value = task(), tasks = new LocalStore(path.join(directory, 'tasks'));
    const decisions = new DelegationStore(path.join(directory, 'decisions'), async () => {});
    const child = (key: string) => ({ key, goal: `Implement ${key}`, deliverable: `${key} change`, baseCommit: base, writeScope: [`src/${key}/`], dependencies: [], acceptance: [`Check ${key}`], testCommands: [], contextRefs: [], provider: 'codex' });
    const split = { ...proposal(), decision: 'delegate', rationale: 'Two independent modules can proceed separately.', children: [child('alpha'), child('beta')] };
    value.delegationPlanner = bindDelegationPlannerTurn(createDelegationPlannerRun(policy(), preferences, runId), { id: turnId });
    await ingestDelegationPlannerCompletion({ task: value, turn: completed(`${plannerMarker}${JSON.stringify(split)}`), decisions });
    await tasks.save([value]);
    const reloaded = await new LocalStore(path.join(directory, 'tasks')).load();
    const saved = await decisions.load(parentId, runId);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0]?.delegationPlanner?.state, 'accepted');
    assert.equal(saved.decisions[0]?.proposal.decision, 'delegate');
    assert.equal(saved.decisions[0]?.proposal.rationale, split.rationale);
    assert.deepEqual(saved.decisions[0]?.proposal.children.map(item => item.key), ['alpha', 'beta']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
