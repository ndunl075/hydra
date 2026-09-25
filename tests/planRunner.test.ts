import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlan, PlanStore, type Plan, type PlanJob } from '../src/core/plans';
import { planHeadKey, planRunRefusal, planSteps, PlanRunner, type PlanHeadLook, type PlanLaneLook, type PlanLook, type PlanRunnerOptions } from '../src/core/planRunner';
import type { DependencyResult } from '../src/core/headStart';

/**
 * The plan runner (docs/Plan_Lanes_Plan.md, section 2) with fake starters: heads and lanes are
 * entries in a fake world that each test moves along by hand.
 */
const job = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });
const lane = (key: string, extra: Partial<PlanJob> = {}): PlanJob => job(key, { runAs: 'lane', ...extra });
const sha = (fill: string) => fill.repeat(40);

type WorldLane = PlanLaneLook & { plan?: { planId: string; jobKey: string; attempt?: number } };
class World {
  readonly heads = new Map<string, PlanHeadLook>();
  readonly lanes = new Map<string, WorldLane>();
  lanesOk = true;
  readonly look: PlanLook = {
    head: id => this.heads.get(id),
    lane: id => this.lanes.get(id),
    planLanes: planId => [...this.lanes].filter(([, item]) => item.plan?.planId === planId && item.state !== 'closed').map(([laneId, item]) => ({ laneId, jobKey: item.plan!.jobKey, attempt: item.plan!.attempt ?? 0 })),
    lanesAvailable: () => this.lanesOk,
  };
  finish(jobId: string, commit = sha('c')) { const head = this.heads.get(jobId)!; head.state = 'done'; head.result = { commit, summary: `${head.title} is done.`, changedFiles: ['src/x.ts'] }; }
}

interface Started { key: string; kind: 'head' | 'lane'; id: string; dependsOn?: string[]; inputs?: DependencyResult[]; key2?: string; base?: string; dependencies?: DependencyResult[] }

async function fixture(jobs: PlanJob[], extra: Partial<PlanRunnerOptions> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-plan-runner-'));
  const store = new PlanStore(directory);
  await store.load();
  const plan = await store.save({ ...createPlan({ title: 'Checkout' }), jobs });
  const world = new World();
  const started: Started[] = [];
  const changes: string[] = [];
  let counter = 0;
  const nextId = () => (++counter).toString(16).padStart(12, '0');
  const runner = new PlanRunner({
    store, look: world.look, repository: directory,
    startHead: async (current, item, dependsOn, inputs) => {
      const id = nextId();
      started.push({ key: item.key, kind: 'head', id, dependsOn, inputs, key2: planHeadKey(current, item) });
      world.heads.set(id, { state: 'queued', title: item.title, branch: `agent/${item.key}-${id}` });
      return { jobId: id };
    },
    startLane: async (current, item, start) => {
      const id = nextId();
      started.push({ key: item.key, kind: 'lane', id, base: start.baseCommit, dependencies: start.dependencies });
      world.lanes.set(id, { name: item.title, state: 'running', branch: `lane/${item.key}-${id}`, baseCommit: start.baseCommit ?? sha('b'), plan: { planId: current.id, jobKey: item.key, attempt: item.attempt ?? 0 } });
      return { laneId: id };
    },
    cancelHead: async id => { const head = world.heads.get(id); if (!head) return; if (head.state === 'failed') head.limitHit = false; else head.state = 'cancelled'; },
    unlinkLane: async id => { const item = world.lanes.get(id); if (item) delete item.plan; },
    commitSubjects: async () => ['Add the schema', 'Wire it up'],
    changedFiles: async () => ['src/merged.ts'],
    terminalsAvailable: () => true,
    onChange: id => changes.push(id),
    debounceMs: 1,
    ...extra,
  });
  const get = () => store.get(plan.id)!;
  const byKey = (key: string) => get().jobs.find(item => item.key === key)!;
  const status = (key: string) => runner.statuses(plan.id)!.find(item => item.key === key)!;
  return { store, plan, world, started, changes, runner, get, byKey, status, close: async () => { runner.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

// ---- Readiness (pure) ----

test('readiness: a lane job waits for all its dependencies; a head waits for its lane dependencies and for its head dependencies to start, not finish', () => {
  const world = new World();
  const base = { ...createPlan({ title: 'Checkout' }), state: 'running' as const };
  const jobs = [job('schema'), lane('api', { dependsOn: ['schema'] }), job('ui', { dependsOn: ['schema'] }), lane('docs', { dependsOn: ['api', 'ui'] }), job('e2e', { dependsOn: ['api'] })];
  let steps = planSteps({ ...base, jobs }, world.look);
  assert.deepEqual(steps.start, [{ key: 'schema', runAs: 'head' }, { key: 'ui', runAs: 'head' }], 'ui starts with schema: its head dependency is starting');
  assert.deepEqual(steps.jobs.map(item => [item.key, item.status]), [['schema', 'active'], ['api', 'waiting'], ['ui', 'active'], ['docs', 'waiting'], ['e2e', 'waiting']]);
  assert.equal(steps.jobs.find(item => item.key === 'api')!.reason, 'Waiting for Job schema');
  assert.equal(steps.jobs.find(item => item.key === 'docs')!.reason, 'Waiting for Job api, Job ui');
  assert.equal(steps.state, 'running');

  // schema and ui are running: nothing new starts; api still waits for schema to finish.
  world.heads.set('00000000000a', { state: 'running', title: 'Job schema' });
  world.heads.set('00000000000b', { state: 'queued', title: 'Job ui' });
  const started = jobs.map(item => item.key === 'schema' ? { ...item, jobId: '00000000000a' } : item.key === 'ui' ? { ...item, jobId: '00000000000b' } : item);
  steps = planSteps({ ...base, jobs: started }, world.look);
  assert.deepEqual(steps.start, []);
  world.finish('00000000000a');
  steps = planSteps({ ...base, jobs: started }, world.look);
  assert.deepEqual(steps.start, [{ key: 'api', runAs: 'lane' }], 'a lane job starts once every job it depends on is done');
  const withLane = started.map(item => item.key === 'api' ? { ...item, laneId: '00000000000c' } : item);
  world.lanes.set('00000000000c', { name: 'Job api', state: 'running', branch: 'lane/api-00000000000c', baseCommit: sha('c') });
  steps = planSteps({ ...base, jobs: withLane }, world.look);
  assert.deepEqual(steps.start, [], 'e2e (a head) waits for api (a lane) to be done');
  const apiDone = withLane.map(item => item.key === 'api' ? { ...item, result: { commit: sha('d'), via: 'marked' as const, at: new Date().toISOString(), changedFiles: [] } } : item);
  steps = planSteps({ ...base, jobs: apiDone }, world.look);
  assert.deepEqual(steps.start, [{ key: 'e2e', runAs: 'head' }]);
  assert.equal(steps.jobs.find(item => item.key === 'docs')!.reason, 'Waiting for Job ui', 'docs still waits for the head ui to finish');
});

test('a dependency cycle starts nothing in it; a draft job waits for Run plan; without lanes, lane jobs neither start nor fail', () => {
  const world = new World();
  const base = { ...createPlan({ title: 'Checkout' }), state: 'running' as const };
  const cyclic = planSteps({ ...base, jobs: [job('a', { dependsOn: ['b'] }), job('b', { dependsOn: ['a'] }), job('c')] }, world.look);
  assert.deepEqual(cyclic.start, [{ key: 'c', runAs: 'head' }]);
  assert.match(cyclic.jobs[0]!.reason!, /dependency cycle/);
  const draft = planSteps({ ...base, jobs: [job('a', { draft: true })] }, world.look);
  assert.deepEqual([draft.start, draft.jobs[0]!.status, draft.state], [[], 'draft', 'incomplete']);
  world.lanesOk = false;
  const noLanes = planSteps({ ...base, jobs: [lane('a'), lane('b', { laneId: '00000000000f' })] }, world.look);
  assert.deepEqual(noLanes.jobs.map(item => item.status), ['waiting', 'active']);
  assert.deepEqual([noLanes.start, noLanes.record], [[], []], 'nothing is failed for a lane Hydra can\'t see');
});

test('no terminals: Run plan refuses up front and names the lane jobs to switch to Head', async () => {
  assert.equal(planRunRefusal({ jobs: [job('a'), lane('b', { title: 'Build API' }), lane('c', { title: 'Docs' })] }, false), 'This build of Hydra has no terminals, so lane jobs can\'t run. Switch Build API, Docs to Head.');
  assert.equal(planRunRefusal({ jobs: [lane('b')] }, true), undefined);
  assert.equal(planRunRefusal({ jobs: [job('a')] }, false), undefined, 'a plan of heads needs no terminal');
  const f = await fixture([job('a'), lane('b', { title: 'Build API' })], { terminalsAvailable: () => false });
  try {
    await assert.rejects(f.runner.run(f.plan.id), /no terminals.*Switch Build API to Head/);
    assert.deepEqual([f.started.length, f.get().state], [0, 'draft'], 'nothing starts and the plan stays a draft');
  } finally { await f.close(); }
  // Retry failed jobs refuses the same way when a lane job would have to start again.
  let terminals = true;
  const g = await fixture([lane('b', { title: 'Build API' })], { terminalsAvailable: () => terminals });
  try {
    await g.runner.run(g.plan.id);
    g.world.lanes.get(g.byKey('b').laneId!)!.state = 'closed';
    await g.runner.advance(g.plan.id);
    assert.equal(g.get().state, 'incomplete');
    terminals = false;
    await assert.rejects(g.runner.retry(g.plan.id), /Switch Build API to Head/);
    assert.equal(g.get().state, 'incomplete');
  } finally { await g.close(); }
});

// ---- The runner ----

test('a plan with only heads creates every head at Run, dependencies mapped to head ids, as before', async () => {
  const f = await fixture([job('tests', { dependsOn: ['api', 'ui'] }), job('ui'), job('api')]);
  try {
    await f.runner.run(f.plan.id);
    assert.deepEqual(f.started.map(item => item.key), ['api', 'ui', 'tests']);
    const ids = new Map(f.started.map(item => [item.key, item.id]));
    assert.deepEqual(f.started[2]!.dependsOn, [ids.get('api'), ids.get('ui')]);
    assert.deepEqual(f.started.map(item => item.key2), [`plan-${f.plan.id}-api`, `plan-${f.plan.id}-ui`, `plan-${f.plan.id}-tests`]);
    assert.equal(f.get().state, 'running');
    assert.equal(f.byKey('tests').jobId, ids.get('tests'));
    for (const id of ids.values()) f.world.finish(id);
    await f.runner.advance(f.plan.id);
    assert.equal(f.get().state, 'done');
  } finally { await f.close(); }
});

test('a chain of heads behind a lane is created in one pass once the lane is marked done, starting from its result', async () => {
  const f = await fixture([lane('schema'), job('api', { dependsOn: ['schema'] }), job('client', { dependsOn: ['api'] }), job('e2e', { dependsOn: ['client', 'schema'] })]);
  try {
    await f.runner.run(f.plan.id);
    assert.deepEqual(f.started.map(item => [item.key, item.kind]), [['schema', 'lane']], 'only the lane starts; the heads wait for it');
    assert.equal(f.started[0]!.base, undefined, 'no dependencies: the main checkout\'s HEAD');
    const laneId = f.started[0]!.id;
    assert.equal(f.byKey('schema').laneId, laneId);
    await f.runner.markLaneDone(f.plan.id, 'schema', laneId, { commit: sha('a'), note: 'The schema is in db/schema.sql.', changedFiles: ['db/schema.sql'] });
    assert.deepEqual(f.started.map(item => item.key), ['schema', 'api', 'client', 'e2e'], 'one pass creates the whole chain');
    const ids = new Map(f.started.map(item => [item.key, item.id]));
    assert.deepEqual(f.started[1]!.dependsOn, []);
    assert.deepEqual(f.started[1]!.inputs, [{ id: laneId, kind: 'lane', title: 'Job schema', summary: 'The schema is in db/schema.sql.', commit: sha('a'), branch: `lane/schema-${laneId}`, changedFiles: ['db/schema.sql'] }]);
    assert.deepEqual(f.started[2]!.dependsOn, [ids.get('api')]);
    assert.deepEqual([f.started[3]!.dependsOn, f.started[3]!.inputs!.map(input => input.id)], [[ids.get('client')], [laneId]], 'heads by id, lanes as inputs');
    assert.deepEqual(f.byKey('schema').result, { commit: sha('a'), via: 'marked', at: f.byKey('schema').result!.at, note: 'The schema is in db/schema.sql.', changedFiles: ['db/schema.sql'] });
    assert.equal(f.status('schema').status, 'done');
  } finally { await f.close(); }
});

test('idempotency: advances at once start each job once, and Run plan again starts only jobs added since', async () => {
  const f = await fixture([job('a'), lane('b'), job('c', { dependsOn: ['a'] })]);
  try {
    await Promise.all([f.runner.run(f.plan.id), f.runner.advance(f.plan.id), f.runner.advance(f.plan.id)]);
    f.runner.advanceSoon(); f.runner.advanceSoon(f.plan.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.started.map(item => item.key).sort(), ['a', 'b', 'c']);
    // + Job on a running plan (decision 5): a draft job waits for Run plan.
    await f.store.update(f.plan.id, plan => ({ ...plan, jobs: [...plan.jobs, job('d', { draft: true, dependsOn: ['a'] })] }));
    await f.runner.advance(f.plan.id);
    assert.equal(f.status('d').status, 'draft');
    assert.equal(f.started.length, 3);
    await f.runner.run(f.plan.id);
    assert.deepEqual(f.started.slice(3).map(item => item.key), ['d'], 'only the new job starts');
    assert.equal(f.byKey('d').draft, undefined, 'Run plan released it');
    await f.runner.run(f.plan.id);
    assert.equal(f.started.length, 4, 'nothing starts twice');
  } finally { await f.close(); }
});

test('a lane whose plan link names a job with no laneId is adopted instead of started again', async () => {
  const f = await fixture([lane('a'), lane('b', { attempt: 1 })]);
  try {
    f.world.lanes.set('0000000000aa', { name: 'Job a', state: 'exited', branch: 'lane/a-0000000000aa', baseCommit: sha('b'), plan: { planId: f.plan.id, jobKey: 'a' } });
    f.world.lanes.set('0000000000bb', { name: 'Job b', state: 'running', branch: 'lane/b-0000000000bb', baseCommit: sha('b'), plan: { planId: f.plan.id, jobKey: 'b' } });
    await f.runner.run(f.plan.id);
    assert.equal(f.byKey('a').laneId, '0000000000aa');
    assert.deepEqual(f.started.map(item => item.key), ['b'], 'a lane from an earlier attempt is never adopted');
  } finally { await f.close(); }
});

test('failures: a lane closed without a result fails its job, and the jobs after it are skipped; the plan becomes incomplete', async () => {
  const f = await fixture([lane('a'), job('b', { dependsOn: ['a'] }), lane('c', { dependsOn: ['b'] }), job('d')]);
  try {
    await f.runner.run(f.plan.id);
    const laneA = f.started.find(item => item.key === 'a')!.id, headD = f.started.find(item => item.key === 'd')!.id;
    f.world.lanes.get(laneA)!.state = 'closed'; f.world.lanes.get(laneA)!.closedAs = 'keep';
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.byKey('a').outcome?.reason, `Lane closed before its job was done (branch lane/a-${laneA} kept).`);
    assert.deepEqual([f.byKey('b').outcome?.state, f.byKey('b').outcome?.reason], ['skipped', 'Job a did not finish.']);
    assert.deepEqual([f.byKey('c').outcome?.state, f.byKey('c').outcome?.reason], ['skipped', 'Job b did not finish.']);
    assert.equal(f.get().state, 'running', 'd is still running');
    f.world.finish(headD);
    await f.runner.advance(f.plan.id);
    assert.equal(f.get().state, 'incomplete');
    // A lane gone from the store entirely (closed long ago) fails the same way.
    const g = await fixture([lane('x')]);
    try {
      await g.runner.run(g.plan.id);
      g.world.lanes.clear();
      await g.runner.advance(g.plan.id);
      assert.equal(g.byKey('x').outcome?.reason, 'Lane closed before its job was done.');
    } finally { await g.close(); }
  } finally { await f.close(); }
});

test('Cancel job cancels a lane job, removes the lane\'s plan link and skips what depends on it; a head job\'s head is stopped', async () => {
  const f = await fixture([lane('a'), job('b', { dependsOn: ['a'] }), job('c')]);
  try {
    await f.runner.run(f.plan.id);
    const laneA = f.byKey('a').laneId!, headC = f.byKey('c').jobId!;
    await f.runner.cancelJob(f.plan.id, 'a', 'Cancelled from the lane.');
    assert.deepEqual([f.byKey('a').outcome?.state, f.byKey('a').outcome?.reason], ['cancelled', 'Cancelled from the lane.']);
    assert.equal(f.world.lanes.get(laneA)!.plan, undefined, 'the lane stays open, as an ordinary lane');
    assert.equal(f.world.lanes.get(laneA)!.state, 'running');
    assert.equal(f.byKey('b').outcome?.state, 'skipped');
    await f.runner.cancelJob(f.plan.id, 'c');
    assert.equal(f.world.heads.get(headC)!.state, 'cancelled');
    assert.equal(f.status('c').status, 'cancelled');
    await assert.rejects(f.runner.cancelJob(f.plan.id, 'c'), /already ended/);
    assert.equal(f.get().state, 'incomplete');
  } finally { await f.close(); }
});

test('a head that hit its usage limit is held: jobs after it wait, and go on once it is continued', async () => {
  const f = await fixture([job('a'), lane('b', { dependsOn: ['a'] }), job('c', { dependsOn: ['a'] }), job('d', { dependsOn: ['b'] })]);
  try {
    await f.runner.run(f.plan.id);
    const headA = f.byKey('a').jobId!;
    Object.assign(f.world.heads.get(headA)!, { state: 'failed', limitHit: true, reason: 'Claude usage limit reached.' });
    await f.runner.advance(f.plan.id);
    assert.deepEqual([f.status('a').status, f.status('a').reason], ['held', 'Claude usage limit reached.']);
    assert.deepEqual([f.status('b').status, f.status('d').status], ['waiting', 'waiting']);
    assert.equal(f.byKey('b').outcome, undefined, 'nothing is skipped while it is held');
    assert.equal(f.get().state, 'running', 'a held job keeps the plan running');
    // Continue in the other provider: the head is queued again, then finishes.
    Object.assign(f.world.heads.get(headA)!, { state: 'queued', limitHit: false });
    await f.runner.advance(f.plan.id);
    assert.equal(f.status('a').status, 'active');
    f.world.finish(headA);
    await f.runner.advance(f.plan.id);
    assert.ok(f.byKey('b').laneId, 'the lane after it starts');
  } finally { await f.close(); }
});

test('giving up on a held head (Cancel job) cancels it and skips the jobs after it', async () => {
  const f = await fixture([job('a'), lane('b', { dependsOn: ['a'] })]);
  try {
    await f.runner.run(f.plan.id);
    const headA = f.byKey('a').jobId!;
    Object.assign(f.world.heads.get(headA)!, { state: 'failed', limitHit: true, reason: 'Codex usage limit reached.' });
    await f.runner.cancelJob(f.plan.id, 'a');
    assert.equal(f.world.heads.get(headA)!.limitHit, false, 'the head was given up on');
    assert.deepEqual([f.status('a').status, f.status('b').status], ['cancelled', 'skipped']);
  } finally { await f.close(); }
});

test('plan state: done when every job is done; incomplete otherwise; Retry failed jobs runs them again with -r1 keys', async () => {
  const f = await fixture([job('a'), job('b'), lane('c', { dependsOn: ['b'] })]);
  try {
    await f.runner.run(f.plan.id);
    f.world.finish(f.byKey('a').jobId!);
    Object.assign(f.world.heads.get(f.byKey('b').jobId!)!, { state: 'failed', reason: 'The head stopped without calling hydra_done or hydra_stuck.' });
    await f.runner.advance(f.plan.id);
    assert.equal(f.get().state, 'incomplete');
    assert.deepEqual([f.status('b').status, f.status('c').status], ['failed', 'skipped']);
    await assert.rejects(f.runner.startJob(f.plan.id, 'c'), /isn't waiting/);
    await f.runner.retry(f.plan.id);
    assert.equal(f.get().state, 'running');
    assert.deepEqual([f.byKey('b').attempt, f.byKey('c').attempt, f.byKey('a').attempt], [1, 1, undefined]);
    const retried = f.started.filter(item => item.key === 'b');
    assert.deepEqual(retried.map(item => item.key2), [`plan-${f.plan.id}-b`, `plan-${f.plan.id}-b-r1`]);
    f.world.finish(f.byKey('b').jobId!);
    await f.runner.advance(f.plan.id);
    const laneC = f.byKey('c').laneId!;
    assert.ok(laneC, 'the skipped lane job starts once b is done');
    f.world.lanes.get(laneC)!.state = 'merged'; f.world.lanes.get(laneC)!.mergedHead = sha('e');
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.byKey('c').result, { commit: sha('e'), via: 'merged', at: f.byKey('c').result!.at, changedFiles: ['src/merged.ts'] }, 'merging is done');
    assert.equal(f.get().state, 'done');
    await assert.rejects(f.runner.retry(f.plan.id), /Only an incomplete plan/);
    await assert.rejects(f.runner.run(f.plan.id), /already done/);
  } finally { await f.close(); }
});

test('startup: a lane job that is ready waits for Start lane; a lane that must wait (24 lanes open) starts later', async () => {
  let full = true;
  const f = await fixture([lane('a'), lane('b')], {});
  try {
    await f.store.update(f.plan.id, plan => ({ ...plan, state: 'running' }));
    await f.runner.advanceAll({ startup: true });
    assert.equal(f.started.length, 0, 'no lane terminal opens while the window starts');
    assert.deepEqual([f.status('a').status, f.status('a').startable, f.status('a').reason], ['waiting', true, 'Ready to start: press Start lane.']);
    await f.runner.advance(f.plan.id);
    assert.equal(f.started.length, 0, 'it keeps waiting after startup');
    await f.runner.startJob(f.plan.id, 'a');
    assert.deepEqual(f.started.map(item => item.key), ['a']);
  } finally { await f.close(); }
  const g = await fixture([lane('a')]);
  const original = (g.runner as unknown as { options: PlanRunnerOptions }).options.startLane;
  (g.runner as unknown as { options: PlanRunnerOptions }).options.startLane = async (plan, item, start) => full ? { wait: 'Waiting: 24 lanes are open.' } : original(plan, item, start);
  try {
    await g.runner.run(g.plan.id);
    assert.deepEqual([g.status('a').status, g.status('a').reason, g.get().state], ['waiting', 'Waiting: 24 lanes are open.', 'running']);
    full = false;
    await g.runner.advance(g.plan.id);
    assert.ok(g.byKey('a').laneId);
  } finally { await g.close(); }
});

test('Mark job done can be pressed again while no dependent has started (decision 3); a start that fails fails the job', async () => {
  const f = await fixture([lane('a'), lane('b'), job('c', { dependsOn: ['a', 'b'] })]);
  try {
    await f.runner.run(f.plan.id);
    const laneA = f.byKey('a').laneId!, laneB = f.byKey('b').laneId!;
    await f.runner.markLaneDone(f.plan.id, 'a', laneA, { commit: sha('1'), changedFiles: ['a.ts'] });
    await f.runner.markLaneDone(f.plan.id, 'a', laneA, { commit: sha('2'), note: 'Moved on.', changedFiles: ['a.ts', 'b.ts'] });
    assert.equal(f.byKey('a').result?.commit, sha('2'), 'the result moves while c hasn\'t started');
    await assert.rejects(f.runner.markLaneDone(f.plan.id, 'a', laneB, { commit: sha('3'), changedFiles: [] }), /doesn't run this plan job/);
    await f.runner.markLaneDone(f.plan.id, 'b', laneB, { commit: sha('4'), changedFiles: ['c.ts'] });
    const c = f.started.find(item => item.key === 'c')!;
    assert.deepEqual(c.inputs!.map(input => [input.commit, input.summary]), [[sha('2'), 'Moved on.'], [sha('4'), 'Add the schema; Wire it up']], 'without a note, the summary is the commit subjects');
    await assert.rejects(f.runner.markLaneDone(f.plan.id, 'a', laneA, { commit: sha('5'), changedFiles: [] }), /Job c already started from 2222222, so this job's result can't move\./);
  } finally { await f.close(); }
  const g = await fixture([lane('a'), job('b')], { startLane: async () => { throw new Error('Codex CLI not found.'); } });
  try {
    await g.runner.run(g.plan.id);
    assert.deepEqual([g.byKey('a').outcome?.state, g.byKey('a').outcome?.reason], ['failed', 'Couldn\'t start: Codex CLI not found.']);
    assert.ok(g.byKey('b').jobId, 'one job\'s trouble never stops the rest');
  } finally { await g.close(); }
});
