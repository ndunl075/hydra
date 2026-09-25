import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canTransitionPlan, createPlan, cycleMessage, dependentsOf, findCycle, jobRunAs, PlanStore, parsePlannerOutput, planJobBriefMax,
  topologicalOrder, validatePlan, validatePlanJobs, type Plan, type PlanJob,
} from '../src/core/plans';
import { writeFile } from 'node:fs/promises';

const job = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });

test('validation: unique keys, resolvable dependencies, size and text limits', () => {
  assert.doesNotThrow(() => validatePlanJobs([job('a'), job('b', { dependsOn: ['a'] })]));
  assert.throws(() => validatePlanJobs([job('a'), job('a')]), /Duplicate job key/);
  assert.throws(() => validatePlanJobs([job('a', { dependsOn: ['nope'] })]), /depends on unknown job/);
  assert.throws(() => validatePlanJobs([job('a', { dependsOn: ['a'] })]), /cannot depend on itself/);
  assert.throws(() => validatePlanJobs([job('BadKey!')]), /Invalid job key/);
  assert.throws(() => validatePlanJobs(Array.from({ length: 13 }, (_, i) => job(`k${i}`))), /at most 12 jobs/);
  assert.throws(() => validatePlanJobs([job('a', { title: '' })]), /title must be/);
  assert.throws(() => validatePlanJobs([job('a', { title: 'x'.repeat(81) })]), /title must be/);
  assert.throws(() => validatePlanJobs([job('a', { brief: 'x'.repeat(4001) })]), /brief must be/);
  assert.throws(() => validatePlanJobs([job('a', { provider: 'gpt' as never })]), /unknown provider/);
  const plan: Plan = { ...createPlan({ title: 'A plan' }), jobs: [job('a')] };
  assert.doesNotThrow(() => validatePlan(plan));
  assert.throws(() => validatePlan({ ...plan, title: '' }), /Plan title must be/);
  assert.throws(() => validatePlan({ ...plan, id: 'bad' }), /Invalid plan id/);
  assert.throws(() => validatePlan({ ...plan, state: 'bogus' as never }), /Invalid plan state/);
  assert.throws(() => validatePlan({ ...plan, brief: 'x'.repeat(8001) }), /Plan brief must be/);
});

test('findCycle finds the path and returns nothing for an acyclic graph', () => {
  assert.equal(findCycle([job('a'), job('b', { dependsOn: ['a'] }), job('c', { dependsOn: ['b'] })]), undefined);
  const cycle = findCycle([job('a', { dependsOn: ['b'] }), job('b', { dependsOn: ['c'] }), job('c', { dependsOn: ['a'] })]);
  assert.deepEqual(cycle, ['a', 'b', 'c', 'a']);
  // A cycle elsewhere in a larger graph is still found, and an unrelated branch does not confuse it.
  const jobs = [job('root'), job('a', { dependsOn: ['root'] }), job('x', { dependsOn: ['y'] }), job('y', { dependsOn: ['x'] })];
  assert.deepEqual(findCycle(jobs), ['x', 'y', 'x']);
  assert.equal(cycleMessage([job('a', { title: 'API' }), job('b', { title: 'UI' })], ['a', 'b', 'a']), 'The plan has a dependency cycle: API → UI → API');
});

test('topologicalOrder puts dependencies first and is deterministic; it names the cycle when there is one', () => {
  const jobs = [job('tests', { dependsOn: ['api', 'ui'] }), job('ui'), job('api'), job('docs', { dependsOn: ['api'] })];
  const order = topologicalOrder(jobs);
  // Both api and ui are ready first (api sorts first); once api starts docs, docs
  // also becomes ready and sorts ahead of ui ("docs" < "ui"); tests waits for both.
  assert.deepEqual(order, ['api', 'docs', 'ui', 'tests']);
  assert.deepEqual(topologicalOrder([job('b'), job('a')]), ['a', 'b'], 'independent jobs sort by key');
  assert.throws(() => topologicalOrder([job('a', { dependsOn: ['b'] }), job('b', { dependsOn: ['a'] })]), /dependency cycle: Job a → Job b → Job a/);
});

test('parsePlannerOutput handles fenced and noisy replies and rejects invalid output', () => {
  const valid = JSON.stringify({ jobs: [{ key: 'api', title: 'API', brief: 'Build the API.', dependsOn: [] }, { key: 'ui', title: 'UI', brief: 'Build the UI.', dependsOn: ['api'], provider: 'codex', writeScope: ['src/ui/'] }] });
  const parsed = parsePlannerOutput(valid);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]!.provider, 'codex');
  assert.deepEqual(parsed[1]!.writeScope, ['src/ui/']);

  const fenced = `Sure, here is the plan:\n\`\`\`json\n${valid}\n\`\`\`\nLet me know if you want changes.`;
  assert.deepEqual(parsePlannerOutput(fenced), parsed);

  // "First JSON object" is literal: prose around it is fine, but an earlier, unrelated
  // JSON object (not just prose) wins and is rejected for not having a "jobs" list.
  const noisy = `Sure, here's the plan.\n\n${valid}\n\nLet me know if you would like any changes.`;
  assert.deepEqual(parsePlannerOutput(noisy), parsed);
  assert.throws(() => parsePlannerOutput(`{"note": "not the plan"} ${valid}`), /must have a "jobs" list/);

  assert.throws(() => parsePlannerOutput('no json here at all'), /did not return a JSON object/);
  assert.throws(() => parsePlannerOutput('{not valid json'), /did not return a JSON object/);
  assert.throws(() => parsePlannerOutput(JSON.stringify({ notJobs: [] })), /must have a "jobs" list/);
  assert.throws(() => parsePlannerOutput(JSON.stringify({ jobs: [{ key: 'only-one', title: 'A', brief: 'b', dependsOn: [] }] })), /2-8 jobs/);
  assert.throws(() => parsePlannerOutput(JSON.stringify({ jobs: [{ key: 'Bad Key', title: 'A', brief: 'b', dependsOn: [] }, { key: 'b', title: 'B', brief: 'b', dependsOn: [] }] })), /invalid key/);
  assert.throws(() => parsePlannerOutput(JSON.stringify({ jobs: [{ key: 'a', title: 'A', brief: 'b', dependsOn: ['nope'] }, { key: 'b', title: 'B', brief: 'b', dependsOn: [] }] })), /depends on unknown job/);
});

async function withStore(run: (store: PlanStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-plans-'));
  try { const store = new PlanStore(directory); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('PlanStore saves, lists, and removes plans, and validates on save', async () => {
  await withStore(async store => {
    const plan: Plan = { ...createPlan({ title: 'A plan', brief: 'Do the thing' }), jobs: [job('a')] };
    const saved = await store.save(plan);
    assert.equal(saved.id, plan.id);
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.get(plan.id)?.jobs.map(j => j.key), ['a']);
    await assert.rejects(store.save({ ...plan, title: '' }), /Plan title must be/);
    assert.equal(store.get(plan.id)?.title, 'A plan', 'a rejected save leaves the stored plan unchanged');
    await store.remove(plan.id);
    assert.equal(store.list().length, 0);
  });
});

test('a plan store reload fails a plan that was still "planning" when Hydra stopped', async () => {
  await withStore(async (store, directory) => {
    const plan = createPlan({ title: 'Mid-brief', brief: 'Go', state: 'planning' });
    await store.save(plan);
    const reloaded = new PlanStore(directory);
    const plans = await reloaded.load();
    assert.equal(plans[0]!.state, 'failed');
    assert.match(plans[0]!.error || '', /Hydra stopped/);
  });
});

// ---- Plan jobs that run as lanes (docs/Plan_Lanes_Plan.md, section 1) ----

const sha = (fill: string) => fill.repeat(40);
const result = { commit: sha('a'), via: 'marked' as const, at: '2026-09-25T10:00:00.000Z', changedFiles: ['src/a.ts'] };
const outcome = { state: 'failed' as const, reason: 'It failed.', at: '2026-09-25T10:00:00.000Z' };

test('validation: runAs values, and ids and results only on the right kind of job', () => {
  for (const runAs of [undefined, 'head', 'lane'] as const) assert.doesNotThrow(() => validatePlanJobs([job('a', runAs ? { runAs } : {})]), String(runAs));
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'agent' as never })]), /must run as a head or a lane/);
  assert.doesNotThrow(() => validatePlanJobs([job('a', { jobId: 'abcdefabcdef' })]));
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', jobId: 'abcdefabcdef' })]), /can't have a head id/);
  assert.throws(() => validatePlanJobs([job('a', { jobId: 'not-an-id' })]), /can't have a head id/);
  assert.doesNotThrow(() => validatePlanJobs([job('a', { runAs: 'lane', laneId: 'abcdefabcdef', result })]));
  assert.throws(() => validatePlanJobs([job('a', { laneId: 'abcdefabcdef' })]), /can't have a lane id/, 'a head job has no lane');
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'head', result })]), /can't have a result/);
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', result: { ...result, commit: 'abc123' } })]), /full commit id/);
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', result: { ...result, changedFiles: Array.from({ length: 301 }, (_, index) => `f${index}`) } })]), /at most 300 changed files/);
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', result: { ...result, note: 'n'.repeat(2001) } })]), /note longer than 2000/);
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', result: { ...result, via: 'pushed' as never } })]), /unknown kind/);
});

test('validation: never both a result and an outcome; outcome reasons are short; a lane brief has a head\'s limit (decision 2)', () => {
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', laneId: 'abcdefabcdef', result, outcome })]), /both a result and an outcome/);
  assert.doesNotThrow(() => validatePlanJobs([job('a', { outcome: { ...outcome, state: 'skipped' } })]));
  assert.throws(() => validatePlanJobs([job('a', { outcome: { ...outcome, reason: 'r'.repeat(501) } })]), /1-500 characters/);
  assert.throws(() => validatePlanJobs([job('a', { outcome: { ...outcome, state: 'lost' as never } })]), /unknown outcome/);
  assert.throws(() => validatePlanJobs([job('a', { attempt: -1 })]), /attempt/);
  // The 2000-character cap went (decision 2): the lane reads its full brief from a file, so a lane job's brief is as long as a head's.
  assert.doesNotThrow(() => validatePlanJobs([job('a', { runAs: 'lane', brief: 'b'.repeat(planJobBriefMax) })]));
  assert.throws(() => validatePlanJobs([job('a', { runAs: 'lane', brief: 'b'.repeat(planJobBriefMax + 1) })]), /brief must be/);
});

test('an old plan with no runAs loads, and its jobs run as heads; the plan states include incomplete', async () => {
  await withStore(async (store, directory) => {
    const old = { version: 1, plans: [{ version: 1, id: 'abcdefabcdef', title: 'Old', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', state: 'running', jobs: [{ key: 'api', title: 'API', brief: 'Build it.', dependsOn: [], jobId: '0123456789ab' }] }] };
    await writeFile(path.join(directory, 'plans.json'), JSON.stringify(old));
    const reloaded = new PlanStore(directory);
    const [plan] = await reloaded.load();
    assert.equal(plan!.jobs[0]!.runAs, undefined);
    assert.equal(jobRunAs(plan!.jobs[0]!), 'head');
    const updated = await reloaded.update(plan!.id, current => ({ ...current, state: 'incomplete' }));
    assert.equal(updated?.state, 'incomplete');
    assert.equal(await reloaded.update('ffffffffffff', current => current), undefined);
  });
  assert.equal(canTransitionPlan('running', 'incomplete'), true);
  assert.equal(canTransitionPlan('incomplete', 'running'), true);
  assert.equal(canTransitionPlan('done', 'running'), false);
  assert.deepEqual(dependentsOf([job('a'), job('b', { dependsOn: ['a'] }), job('c', { dependsOn: ['b'] }), job('d')], 'a').map(item => item.key), ['b', 'c']);
});
