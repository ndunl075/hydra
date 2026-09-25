import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { LaneStore, laneJobBriefFile, laneNameFromTitle, lanePreamble, lanePreambleMax, parseLaneName, validateLane, type Lane, type LanePlanLink } from '../src/core/lanes';
import { LaneService, writeLaneJobBrief } from '../src/core/laneService';
import { laneDiffBase, LaneSync } from '../src/core/laneSync';
import { laneDiffFiles } from '../src/core/laneFinish';
import { createPlan, PlanStore, type PlanJob } from '../src/core/plans';
import { PlanRunner, type PlanHeadLook } from '../src/core/planRunner';
import type { GateRuntime } from '../src/core/gates';
import { fakePtyModule } from './lanePtyFake';

/** Plan lanes against real git (docs/Plan_Lanes_Plan.md): where a lane starts, what it hands on, and what it is measured from. */
async function fixture(gates?: unknown) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-plan-lanes-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [['user.email', 'test@example.invalid'], ['user.name', 'Test'], ['core.autocrlf', 'false']]) await git(repo, ['config', key!, value!]);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(gates)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const write = async (folder: string, file: string, text: string) => { await mkdir(path.dirname(path.join(folder, file)), { recursive: true }); await writeFile(path.join(folder, file), text); };
  const commit = async (folder: string, file: string, text: string, message = `change ${file}`) => { await write(folder, file, text); await git(folder, ['add', '-A']); await git(folder, ['commit', '-qm', message]); return (await git(folder, ['rev-parse', 'HEAD'])).trim(); };
  /** A commit on its own branch, off main, not merged: a dependency's finished work. */
  const sideCommit = async (branch: string, file: string, text: string) => {
    await git(repo, ['switch', '-q', '-c', branch]);
    const made = await commit(repo, file, text, `${branch}: ${file}`);
    await git(repo, ['switch', '-q', 'main']);
    return made;
  };
  const store = new LaneStore(path.join(root, 'storage'));
  await store.load();
  const pty = fakePtyModule();
  const gateRuns: string[] = [];
  const gatesRuntime: Partial<GateRuntime> = {
    pollMs: 5,
    runCommand: async command => { gateRuns.push(command.args[0] || command.executable); return { exitCode: 0, unavailable: false, interrupted: false, timedOut: false, logFailed: false, logged: true }; },
  };
  const service = new LaneService({
    store, repository: repo, worktreeRoot: () => undefined, pty,
    executable: async provider => path.join(root, 'bin', `${provider}.exe`), connected: async () => true,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'storage', 'lanes'),
    syncIntervalMs: 60_000, env: () => ({ PATH: 'x' }),
    gatesExecutable: async provider => `fake-${provider}`, gatesLogDirectory: path.join(root, 'gates'), gatesRuntime,
  });
  return { root, repo, store, service, pty, gateRuns, write, commit, sideCommit, close: async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}
const link = (extra: Partial<LanePlanLink> = {}): LanePlanLink => ({ planId: 'abcdefabcdef', jobKey: 'build-api', planTitle: 'Checkout', jobTitle: 'Build API', ...extra });

test('a plan lane starts from a base commit, with its plan link, and its full brief in an ignored file that is never committed', async () => {
  const f = await fixture();
  try {
    const schema = await f.sideCommit('schema', 'src/schema.ts', 'export const schema = 1;\n');
    const brief = `Build the API.\n${'Details. '.repeat(400)}`;
    const lane = await f.service.create({ name: 'Build API', provider: 'claude', goal: brief.slice(0, 2000) }, {
      baseCommit: schema, plan: link({ startsFrom: [{ title: 'Schema', commit: schema }], writeScope: ['src/api/'] }), brief,
    });
    assert.equal(lane.baseCommit, schema, 'the worktree starts from the dependency\'s work');
    assert.equal(await readFile(path.join(lane.worktree, 'src', 'schema.ts'), 'utf8'), 'export const schema = 1;\n');
    assert.deepEqual(f.store.get(lane.id)!.plan, link({ startsFrom: [{ title: 'Schema', commit: schema }], writeScope: ['src/api/'] }));
    assert.equal(await readFile(path.join(lane.worktree, ...laneJobBriefFile.split('/')), 'utf8'), brief, 'the whole brief, past the 2000-character goal');
    assert.equal((await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(), '', 'git never sees the brief');
    await f.commit(lane.worktree, 'src/api/index.ts', 'export const api = 1;\n');
    assert.equal((await git(lane.worktree, ['show', '--name-only', '--format=', 'HEAD'])).trim(), 'src/api/index.ts', 'git add -A leaves it out');
    const [spawned] = f.pty.spawned;
    const prompt = spawned!.args.at(-1)!;
    assert.match(prompt, new RegExp(`This lane runs job "Build API" of Hydra plan "Checkout"\\. It starts from the work of Schema \\(${schema.slice(0, 12)}\\)\\. Stay within src/api/ if you can\\. The job's full brief is in \\.hydra-job/brief\\.md \\(never committed\\); read it first\\. When the work is ready, commit it and call hydra_job_ready; the user marks the job done or merges the lane\\.`));
    assert.doesNotMatch(prompt, /[\r\n]/);
    assert.equal(spawned!.options!.env.HYDRA_LANE_PLAN_JOB, '1', 'its bridge offers hydra_job_ready');
    // A worktree that already has the folder (tracked, or a link) is never written through.
    await assert.rejects(writeLaneJobBrief(lane.worktree, 'again'), /already has a \.hydra-job folder/);
    // Closing with Keep branch works with the ignored file there, and says so on the record.
    await f.service.close(lane.id, 'keep');
    assert.equal(f.store.get(lane.id)!.closedAs, 'keep');
  } finally { await f.close(); }
});

test('laneDiffBase: the base commit while the dependency work isn\'t in the target, where the lane meets it afterwards', async () => {
  const f = await fixture();
  try {
    const schema = await f.sideCommit('schema', 'src/schema.ts', 'schema\n');
    const lane = await f.service.create({ name: 'Build API', provider: 'claude' }, { baseCommit: schema, plan: link() });
    const own = await f.commit(lane.worktree, 'src/api.ts', 'api\n');
    assert.equal(await laneDiffBase(lane, own), schema);
    assert.deepEqual((await laneDiffFiles(lane)).files, [{ path: 'src/api.ts', status: 'A' }], 'the diff shows only this job\'s work');
    const synced = (await new LaneSync().run([lane])).get(lane.id)!;
    assert.deepEqual(synced.changedFiles, ['src/api.ts'], 'and so does the changed-files count');
    // The dependency is merged into main, main moves on, and the lane updates from main.
    await git(f.repo, ['merge', '-q', '--no-edit', 'schema']);
    await f.commit(f.repo, 'README.md', 'readme\n');
    await git(lane.worktree, ['merge', '-q', '--no-edit', 'main']);
    const head = (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim();
    const tip = (await git(f.repo, ['rev-parse', 'main'])).trim();
    assert.equal(await laneDiffBase(lane, head), tip, 'the merge-base with main, once the base is in main');
    assert.deepEqual((await laneDiffFiles(lane)).files, [{ path: 'src/api.ts', status: 'A' }], 'main\'s own work isn\'t counted');
    // An ordinary lane is measured from where it meets main, as always.
    const plain = await f.service.create({ name: 'Plain', provider: 'claude' });
    assert.equal(await laneDiffBase(plain, plain.baseCommit), plain.baseCommit);
  } finally { await f.close(); }
});

test('Mark job done refuses a dirty lane and one with nothing to hand on, and hands on HEAD with its files and subjects; Merge records mergedHead', async () => {
  const f = await fixture();
  try {
    const lane = await f.service.create({ name: 'Build API', provider: 'claude' }, { plan: link(), brief: 'Build it.' });
    assert.deepEqual(await f.service.handOn(lane.id), { ok: false, reason: 'nothing', message: 'Nothing to hand on yet.' });
    await f.write(lane.worktree, 'src/api.ts', 'api\n');
    assert.deepEqual(await f.service.handOn(lane.id), { ok: false, reason: 'dirty', message: 'Lane Build API has uncommitted changes. Commit them first.' });
    await git(lane.worktree, ['add', '-A']); await git(lane.worktree, ['commit', '-qm', 'Add the API']);
    const head = await f.commit(lane.worktree, 'src/api.test.ts', 'test\n', 'Test the API');
    const handed = await f.service.handOn(lane.id);
    assert.deepEqual(handed, { ok: true, commit: head, base: lane.baseCommit, changedFiles: ['src/api.test.ts', 'src/api.ts'], subjects: ['Test the API', 'Add the API'] });

    // The runner records it with the note, and the result stays put when the lane moves on.
    const directory = path.join(f.root, 'plans');
    const plans = new PlanStore(directory); await plans.load();
    const job: PlanJob = { key: 'build-api', title: 'Build API', brief: 'Build it.', dependsOn: [], runAs: 'lane', laneId: lane.id };
    const plan = await plans.save({ ...createPlan({ title: 'Checkout' }), id: 'abcdefabcdef', state: 'running', jobs: [job] });
    const runner = new PlanRunner({
      store: plans, repository: f.repo,
      look: { head: () => undefined, lane: id => f.service.record(id), planLanes: () => [], lanesAvailable: () => true },
      startHead: async () => { throw new Error('unused'); }, startLane: async () => { throw new Error('unused'); },
      cancelHead: async () => undefined, unlinkLane: id => f.service.unlinkPlan(id),
      commitSubjects: async () => [], changedFiles: async () => [], terminalsAvailable: () => true,
    });
    if (!handed.ok) throw new Error('unreachable');
    await runner.markLaneDone(plan.id, 'build-api', lane.id, { commit: handed.commit, note: 'The API is in src/api.ts.', changedFiles: handed.changedFiles });
    const recorded = plans.get(plan.id)!;
    assert.deepEqual({ ...recorded.jobs[0]!.result, at: undefined }, { commit: head, via: 'marked', at: undefined, note: 'The API is in src/api.ts.', changedFiles: ['src/api.test.ts', 'src/api.ts'] });
    assert.equal(recorded.state, 'done');
    await f.commit(lane.worktree, 'src/later.ts', 'later\n');

    // Merge still merges the lane, and records the HEAD it merged.
    const later = (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim();
    await f.service.merge(lane.id);
    assert.equal(f.store.get(lane.id)!.mergedHead, later);
    assert.equal(plans.get(plan.id)!.jobs[0]!.result!.commit, head, 'the result doesn\'t move');
    runner.dispose();
  } finally { await f.close(); }
});

test('Merge reuses a passing gates run on the same commit; a new commit, uncommitted work or a changed gates file runs them again', async () => {
  const gates = { lanes: 'onMerge', gates: [{ id: 'unit', type: 'command', command: ['unit'] }] };
  const f = await fixture(gates);
  try {
    const lane = await f.service.create({ name: 'Gated', provider: 'claude' });
    const head = await f.commit(lane.worktree, 'src/g.ts', 'g\n');
    await f.service.runGates(lane.id);
    const record = f.store.get(lane.id)!.lastGates!;
    assert.equal(record.commit, head, 'recorded on the clean HEAD');
    assert.match(record.config!, /^[a-f0-9]{16}$/);
    assert.equal((await f.service.reusableGates(lane.id))?.commit, head);
    await f.write(lane.worktree, 'src/scratch.ts', 'x\n');
    assert.equal(await f.service.reusableGates(lane.id), undefined, 'not while the lane has uncommitted work');
    await rm(path.join(lane.worktree, 'src', 'scratch.ts'));
    assert.equal((await f.service.reusableGates(lane.id))?.commit, head);
    await writeFile(path.join(f.repo, '.hydra', 'gates.json'), JSON.stringify({ ...gates, gates: [...gates.gates, { id: 'lint', type: 'command', command: ['lint'] }] }));
    assert.equal(await f.service.reusableGates(lane.id), undefined, 'not once the gates file changed');
    await writeFile(path.join(f.repo, '.hydra', 'gates.json'), JSON.stringify(gates));
    assert.equal((await f.service.reusableGates(lane.id))?.commit, head);
    await f.commit(lane.worktree, 'src/h.ts', 'h\n');
    assert.equal(await f.service.reusableGates(lane.id), undefined, 'not on a newer commit');
    // A run on a dirty lane records no commit: it can't be reused.
    await f.write(lane.worktree, 'src/dirty.ts', 'x\n');
    await f.service.runGates(lane.id);
    assert.equal(f.store.get(lane.id)!.lastGates!.commit, undefined);
    assert.deepEqual(f.gateRuns, ['unit', 'unit']);
  } finally { await f.close(); }
});

test('a lane job starts from two heads\' results, merged; dependencies that conflict fail the job with the files named', async () => {
  const f = await fixture();
  try {
    const one = await f.sideCommit('one', 'src/one.ts', 'one\n');
    const two = await f.sideCommit('two', 'src/two.ts', 'two\n');
    const clashA = await f.sideCommit('clash-a', 'src/shared.ts', 'a\n');
    const clashB = await f.sideCommit('clash-b', 'src/shared.ts', 'b\n');
    const heads = new Map<string, PlanHeadLook>([
      ['00000000000a', { state: 'done', title: 'One', branch: 'one', result: { commit: one, summary: 'Did one.', changedFiles: ['src/one.ts'] } }],
      ['00000000000b', { state: 'done', title: 'Two', branch: 'two', result: { commit: two, summary: 'Did two.', changedFiles: ['src/two.ts'] } }],
      ['00000000000c', { state: 'done', title: 'Clash A', result: { commit: clashA, summary: 'A.', changedFiles: ['src/shared.ts'] } }],
      ['00000000000d', { state: 'done', title: 'Clash B', result: { commit: clashB, summary: 'B.', changedFiles: ['src/shared.ts'] } }],
    ]);
    const plans = new PlanStore(path.join(f.root, 'plans')); await plans.load();
    const head = (key: string, jobId: string): PlanJob => ({ key, title: key, brief: 'b', dependsOn: [], jobId });
    const plan = await plans.save({ ...createPlan({ title: 'Merge' }), jobs: [
      head('one', '00000000000a'), head('two', '00000000000b'), head('clash-a', '00000000000c'), head('clash-b', '00000000000d'),
      { key: 'both', title: 'Both', brief: 'b', dependsOn: ['one', 'two'], runAs: 'lane' },
      { key: 'clashing', title: 'Clashing', brief: 'b', dependsOn: ['clash-a', 'clash-b'], runAs: 'lane' },
    ] });
    const lanes: { key: string; base?: string; titles: string[] }[] = [];
    const runner = new PlanRunner({
      store: plans, repository: f.repo,
      look: { head: id => heads.get(id), lane: () => undefined, planLanes: () => [], lanesAvailable: () => true },
      startHead: async () => { throw new Error('unused'); },
      startLane: async (_plan, job, start) => { lanes.push({ key: job.key, base: start.baseCommit, titles: start.dependencies.map(item => `${item.kind}:${item.title}`) }); return { laneId: '0000000000ee' }; },
      cancelHead: async () => undefined, unlinkLane: async () => undefined,
      commitSubjects: async () => [], changedFiles: async () => [], terminalsAvailable: () => true,
    });
    await runner.run(plan.id);
    assert.deepEqual(lanes.map(item => [item.key, item.titles]), [['both', ['head:one', 'head:two']]]);
    const [, ...parents] = (await git(f.repo, ['rev-list', '--parents', '-n', '1', lanes[0]!.base!])).trim().split(' ');
    assert.deepEqual(parents, [one, two], 'one commit whose parents are both results');
    const clashing = plans.get(plan.id)!.jobs.find(job => job.key === 'clashing')!;
    assert.deepEqual([clashing.outcome?.state, clashing.outcome?.reason], ['failed', 'The jobs it depends on conflict in src/shared.ts; merge them first.']);
    runner.dispose();
  } finally { await f.close(); }
});

// ---- Text (pure) ----

const id = 'abcdef012345';
const sample = (extra: Partial<Lane> = {}): Lane => ({
  id, name: 'Build API', provider: 'claude', goal: 'Build the API', repository: path.resolve('/repo'), worktree: path.resolve('/repo.worktrees', `lane-${id}`),
  branch: `lane/build-api-${id}`, baseCommit: 'a'.repeat(40), target: 'main', createdAt: '2026-09-25T10:00:00.000Z', state: 'running', ...extra,
});

test('the first prompt of a plan lane has the plan sentence and stays one line under the cap', () => {
  const text = lanePreamble({ name: 'Build API', branch: `lane/build-api-${id}`, goal: 'Build the API', plan: link({ startsFrom: [{ title: 'Schema', commit: 'a1b2c3d4e5f6'.padEnd(40, '0') }], writeScope: ['src/api/'] }) }, []);
  assert.equal(text, `You are working in Hydra lane "Build API" on branch lane/build-api-${id}. This lane runs job "Build API" of Hydra plan "Checkout". It starts from the work of Schema (a1b2c3d4e5f6). Stay within src/api/ if you can. The job's full brief is in .hydra-job/brief.md (never committed); read it first. When the work is ready, commit it and call hydra_job_ready; the user marks the job done or merges the lane. No other lanes are in progress. Call hydra_lanes to check again before large changes, and avoid editing files other lanes are changing. Your task: Build the API`);
  const crowded = Array.from({ length: 20 }, (_, index) => ({ name: `Lane ${index}`, provider: 'codex' as const, goal: 'g'.repeat(500), files: Array.from({ length: 50 }, (_, file) => `src/${'deep/'.repeat(30)}file-${file}.ts`) }));
  const long = lanePreamble({ name: 'Build API', branch: 'lane/x', goal: 'task '.repeat(400), plan: link({ planTitle: 'P\n'.repeat(100).slice(0, 200), jobTitle: 'J'.repeat(80), startsFrom: Array.from({ length: 12 }, (_, index) => ({ title: `Dependency\r\n${index}`.padEnd(80, 'x'), commit: 'b'.repeat(40) })), writeScope: Array.from({ length: 32 }, (_, index) => `src/${'x'.repeat(280)}${index}/`) }) }, crowded);
  assert.ok(long.length <= lanePreambleMax, `${long.length}`);
  assert.doesNotMatch(long, /[\r\n]/);
  assert.match(long, /The job's full brief is in \.hydra-job\/brief\.md \(never committed\); read it first\. When the work is ready, commit it and call hydra_job_ready; the user marks the job done or merges the lane\..*Your task: task/, 'the brief\'s place, the way to finish and the task always survive');
});

test('laneNameFromTitle always gives a valid lane name', () => {
  assert.equal(laneNameFromTitle('Build API'), 'Build API');
  assert.equal(laneNameFromTitle('Checkout: "fast" & cheap! (v2) #3'), 'Checkout fast cheap (v2) #3');
  assert.equal(laneNameFromTitle('!!!'), 'Plan job');
  assert.equal(laneNameFromTitle(''), 'Plan job');
  assert.equal(laneNameFromTitle('x'.repeat(80)), 'x'.repeat(40));
  assert.equal(laneNameFromTitle(`${'y'.repeat(39)} tail`), 'y'.repeat(39), 'a cut never leaves a trailing space');
  const pieces = ['a', 'Ü', '😀', '𝒜', ' ', '&', '"', '\'', '%', '|', '<', '>', '^', '!', '\n', '\u0007', '(', ')', '#', '-', '_', '.', '/', ':', '9', '中'];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let run = 0; run < 500; run++) {
    const title = Array.from({ length: Math.floor(random() * 90) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const name = laneNameFromTitle(title);
    assert.doesNotThrow(() => parseLaneName(name), JSON.stringify(title));
    assert.ok(name.length <= 40 && name === name.trim(), JSON.stringify(name));
  }
});

test('a stored lane\'s plan link, merged HEAD, close mode and gates commit are validated', () => {
  const plan = link({ attempt: 2, startsFrom: [{ title: 'Schema', commit: 'c'.repeat(40) }], writeScope: ['src/'] });
  assert.deepEqual(validateLane(sample({ plan, mergedHead: 'd'.repeat(40), closedAs: 'keep', lastGates: { source: 'gates', at: '2026-09-25T10:00:00.000Z', results: [], commit: 'e'.repeat(40), config: 'f'.repeat(16) } })).plan, plan);
  assert.throws(() => validateLane(sample({ plan: { ...plan, planId: 'nope' } })), /invalid plan link/);
  assert.throws(() => validateLane(sample({ plan: { ...plan, jobKey: 'Bad Key' } })), /invalid plan link/);
  assert.throws(() => validateLane(sample({ plan: { ...plan, jobTitle: 'j'.repeat(81) } })), /invalid plan title/);
  assert.throws(() => validateLane(sample({ plan: { ...plan, startsFrom: [{ title: 'x', commit: 'short' }] } })), /invalid plan start/);
  assert.throws(() => validateLane(sample({ plan: { ...plan, writeScope: ['a\0b'] } })), /invalid plan write scope/);
  assert.throws(() => validateLane(sample({ mergedHead: 'HEAD' })), /invalid merged commit/);
  assert.throws(() => validateLane(sample({ closedAs: 'burn' as never })), /invalid close mode/);
  assert.throws(() => validateLane(sample({ lastGates: { source: 'gates', at: '2026-09-25T10:00:00.000Z', results: [], commit: 'x' } })), /invalid gates commit/);
});
