import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allJobsDone, createPlan, cycleMessage, findCycle, jobsToStart, PlanStore, parsePlannerOutput, runPlan,
  topologicalOrder, validatePlan, validatePlanJobs, type Plan, type PlanJob,
} from '../src/core/plans';

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

test('jobsToStart is idempotent: only jobs without a jobId, in dependency order', () => {
  const jobs = [job('api'), job('ui', { jobId: 'aaaaaaaaaaaa' }), job('tests', { dependsOn: ['api', 'ui'] })];
  assert.deepEqual(jobsToStart({ jobs }).map(j => j.key), ['api', 'tests']);
  assert.deepEqual(jobsToStart({ jobs: jobs.map(j => ({ ...j, jobId: j.jobId ?? 'bbbbbbbbbbbb' })) }), []);
});

test('allJobsDone requires every job to have started and finished', () => {
  const state = new Map([['a', 'done'], ['b', 'running']]);
  assert.equal(allJobsDone({ jobs: [job('x', { jobId: 'a' }), job('y', { jobId: 'b' })] }, key => state.get(key)), false);
  assert.equal(allJobsDone({ jobs: [job('x', { jobId: 'a' })] }, key => state.get(key)), true);
  assert.equal(allJobsDone({ jobs: [job('x')] }, key => state.get(key)), false, 'a job that never started is not done');
  assert.equal(allJobsDone({ jobs: [] }, () => 'done'), false, 'an empty plan is never done on its own');
});

test('runPlan starts jobs in dependency order, maps dependsOn to real head ids, and refuses a cycle without starting anything', async () => {
  const plan: Plan = { ...createPlan({ title: 'Checkout refactor' }), state: 'draft', jobs: [job('api'), job('ui'), job('tests', { dependsOn: ['api', 'ui'] })] };
  const started: { key: string; dependsOn: readonly string[] }[] = [];
  let counter = 0;
  const start = async (job: PlanJob, dependsOn: readonly string[]) => { started.push({ key: job.key, dependsOn }); return { jobId: `head-${job.key}-${counter++}` }; };
  const running = await runPlan(plan, start);
  assert.equal(running.state, 'running');
  assert.deepEqual(started.map(item => item.key), ['api', 'ui', 'tests']);
  const testsJob = running.jobs.find(j => j.key === 'tests')!;
  const apiJob = running.jobs.find(j => j.key === 'api')!;
  const uiJob = running.jobs.find(j => j.key === 'ui')!;
  assert.deepEqual([...started.find(item => item.key === 'tests')!.dependsOn].sort(), [apiJob.jobId, uiJob.jobId].sort());
  assert.ok(testsJob.jobId);

  // Idempotent: running again with a new job started starts only the new one.
  const withNewJob: Plan = { ...running, jobs: [...running.jobs, job('docs', { dependsOn: ['api'] })] };
  const startedAgain: string[] = [];
  const again = await runPlan(withNewJob, async job => { startedAgain.push(job.key); return { jobId: 'head-docs-9' }; });
  assert.deepEqual(startedAgain, ['docs']);
  assert.equal(again.jobs.find(j => j.key === 'api')!.jobId, apiJob.jobId, 'already-started jobs keep their head id');

  const cyclic: Plan = { ...createPlan({ title: 'Bad plan' }), jobs: [job('a', { dependsOn: ['b'] }), job('b', { dependsOn: ['a'] })] };
  await assert.rejects(runPlan(cyclic, async () => { throw new Error('must not start anything'); }), /dependency cycle/);
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
