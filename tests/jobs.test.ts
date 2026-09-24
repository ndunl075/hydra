import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobStore, canTransition, finalJobStates, jobStates, jobTransitions, parseJobInput, parseWriteScope, type JobInput } from '../src/core/jobs';

const input = (key = 'k1', extra: Partial<JobInput> = {}): JobInput => ({ title: 'Parser', brief: 'Fix the parser', writeScope: ['src/'], provider: 'claude', idempotencyKey: key, ...extra });
async function withStore(run: (store: JobStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-jobs-'));
  try { const store = new JobStore(directory); await store.load(); await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('every state change not in the table is refused, and final states allow none', async () => {
  for (const from of jobStates) for (const to of jobStates) assert.equal(canTransition(from, to), jobTransitions[from].includes(to), `${from} -> ${to}`);
  for (const state of finalJobStates) assert.deepEqual(jobTransitions[state], []);
  await withStore(async store => {
    // Walk every allowed path from queued and try every refused edge on the way.
    const { job } = await store.create('lead', input());
    await assert.rejects(store.transition(job.id, 'done'), /cannot go from queued to done/);
    await store.transition(job.id, 'starting');
    await store.transition(job.id, 'running');
    await store.transition(job.id, 'blocked', 'Which API?', { question: 'Which API?' });
    await assert.rejects(store.transition(job.id, 'checking'), /cannot go from blocked to checking/);
    await store.transition(job.id, 'running');
    await store.transition(job.id, 'checking');
    await store.transition(job.id, 'running', 'Checks failed');
    await store.transition(job.id, 'checking');
    const done = await store.transition(job.id, 'done', undefined, { result: { summary: 'ok', commit: 'a'.repeat(40), changedFiles: ['src/a.ts'], checks: [] } });
    assert.equal(done.state, 'done'); assert.ok(done.finishedAt); assert.ok(done.startedAt);
    assert.deepEqual(done.history.map(event => event.to), ['queued', 'starting', 'running', 'blocked', 'running', 'checking', 'running', 'checking', 'done']);
    for (const to of jobStates) await assert.rejects(store.transition(job.id, to), /cannot go from done/);
    await assert.rejects(store.update(job.id, { progress: 'late' }), /is done/);
  });
});

test('a repeated idempotency key returns the first job; another lead gets its own', async () => {
  await withStore(async store => {
    const first = await store.create('lead-a', input('same'));
    const again = await store.create('lead-a', input('same', { title: 'Different' }));
    assert.equal(first.created, true); assert.equal(again.created, false);
    assert.equal(again.job.id, first.job.id); assert.equal(again.job.title, 'Parser');
    const other = await store.create('lead-b', input('same'));
    assert.notEqual(other.job.id, first.job.id);
    assert.equal(store.list('lead-a').length, 1);
    await assert.rejects(store.create('lead-b', input('dep', { dependsOn: [first.job.id] })), /unknown job/, 'a lead cannot depend on another lead\'s job');
  });
});

test('a save that fails midway leaves the previous file readable and memory unchanged', async () => {
  await withStore(async (store, directory) => {
    const { job } = await store.create('lead', input());
    const before = await readFile(path.join(directory, 'jobs.json'), 'utf8');
    // Make the destination unreplaceable: turn jobs.json into a directory-shaped obstacle.
    const file = path.join(directory, 'jobs.json');
    await rm(file); await import('node:fs/promises').then(fs => fs.mkdir(path.join(file, 'blocked'), { recursive: true }));
    await assert.rejects(store.transition(job.id, 'starting'));
    assert.equal(store.get(job.id)?.state, 'queued', 'memory keeps the last saved state');
    await rm(file, { recursive: true, force: true }); await writeFile(file, before);
    const reloaded = new JobStore(directory); await reloaded.load();
    assert.equal(reloaded.get(job.id)?.state, 'queued');
  });
});

test('a lock left by a crashed writer is cleared instead of blocking the store for good', async () => {
  await withStore(async (store, directory) => {
    await writeFile(path.join(directory, 'jobs.json.lock'), JSON.stringify({ pid: 999999, token: 'dead', at: Date.now() }));
    const { job } = await store.create('lead', input());
    assert.equal(job.state, 'queued');
    await writeFile(path.join(directory, 'jobs.json.lock'), JSON.stringify({ pid: process.pid, token: 'old', at: Date.now() - 60_000 }));
    await store.transition(job.id, 'cancelled', 'Lead cancelled');
    assert.equal(store.get(job.id)?.state, 'cancelled');
  });
});

test('after a restart, heads that were running are failed with the reason; queued and blocked jobs keep their state', async () => {
  await withStore(async (store, directory) => {
    const running = (await store.create('lead', input('r'))).job;
    await store.transition(running.id, 'starting'); await store.transition(running.id, 'running');
    const blocked = (await store.create('lead', input('b'))).job;
    await store.transition(blocked.id, 'starting'); await store.transition(blocked.id, 'running'); await store.transition(blocked.id, 'blocked', 'Need a decision');
    const queued = (await store.create('lead', input('q'))).job;
    const reloaded = new JobStore(directory); await reloaded.load();
    assert.equal(reloaded.get(running.id)?.state, 'failed');
    assert.match(reloaded.get(running.id)?.reason || '', /Hydra stopped/);
    assert.equal(reloaded.get(blocked.id)?.state, 'blocked');
    assert.equal(reloaded.get(queued.id)?.state, 'queued');
  });
});

test('job input from a provider is validated', () => {
  const parsed = parseJobInput({ title: ' Parser ', brief: 'Fix it', write_scope: ['./src', 'tests\\unit'], idempotency_key: 'x', limits: { wall_clock_minutes: 10, max_turns: 1000 } });
  assert.deepEqual(parsed.writeScope, ['src', 'tests/unit']);
  assert.equal(parsed.provider, 'claude'); assert.equal(parsed.title, 'Parser');
  assert.equal(parsed.limits?.wallClockMs, 600_000); assert.equal(parsed.limits?.maxTurns, 500);
  for (const scope of [['../x'], ['/etc'], ['C:\\Windows'], [], 'src']) assert.throws(() => parseWriteScope(scope));
  assert.throws(() => parseJobInput({ title: 'x', brief: 'y', write_scope: ['src'], idempotency_key: 'k', provider: 'gpt' }), /provider/);
  assert.throws(() => parseJobInput({ title: '', brief: 'y', write_scope: ['src'], idempotency_key: 'k' }), /title/);
  assert.throws(() => parseJobInput({ title: 'x', brief: 'y', write_scope: ['src'], idempotency_key: 'k', depends_on: ['nope'] }), /depends_on/);
});

test('a malformed store is refused rather than silently emptied', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-jobs-'));
  try {
    await writeFile(path.join(directory, 'jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'bad' }] }));
    await assert.rejects(new JobStore(directory).load(), /malformed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
