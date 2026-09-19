import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { digest } from '../src/core/delegationContext';
import { DelegationEvaluationLedger, parseDelegationEvaluationObservation, projectDelegationEvaluationLedger } from '../src/core/delegationEvaluationLedger';

const corpus = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/corpus-v1.json', 'utf8'));
const descriptors = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/paired-runs-v1.json', 'utf8'));
const seal = (value: any) => { const { sha256: _ignored, ...unsigned } = value; value.sha256 = digest(JSON.stringify(unsigned)); return value; };
const observation = (mode: 'auto' | 'solo', runId: string, coverage: 'available' | 'partial' | 'unavailable' = 'available') => {
  const descriptor = descriptors()[mode];
  return seal({ version: 1, id: mode === 'auto' ? '111111111111111111111111' : '222222222222222222222222', pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa', runId, descriptor,
    acceptance: 'passed', quality: { status: 'passed', score: 92.5 }, elapsedTime: { status: 'passed', milliseconds: 1234 }, reportedUsage: coverage === 'unavailable' ? { coverage } : { coverage, tokens: 100 }, regressions: { status: 'passed', count: 0 }, integrationConflicts: { status: 'passed', count: 0 }, manualRework: { status: 'passed', minutes: 0 }, artifacts: [{ label: 'summary', path: `evidence/${mode}.json`, sha256: 'c'.repeat(64) }] });
};

test('records bind to the exact immutable corpus/case/settings and retain only references', () => {
  const value = observation('auto', '333333333333333333333333');
  assert.equal(parseDelegationEvaluationObservation(value, corpus()).descriptor.mode, 'auto');
  const changed = structuredClone(value); changed.descriptor.caseSha256 = 'b'.repeat(64); seal(changed);
  assert.throws(() => parseDelegationEvaluationObservation(changed, corpus()), /immutable corpus case/);
  const transcript = structuredClone(value); (transcript as any).transcript = 'provider output'; seal(transcript);
  assert.throws(() => parseDelegationEvaluationObservation(transcript, corpus()), /fields/);
  const badArtifact = structuredClone(value); badArtifact.artifacts[0].path = '../logs/full.txt'; seal(badArtifact);
  assert.throws(() => parseDelegationEvaluationObservation(badArtifact, corpus()), /artifact/);
});

test('exact replay is a durable no-op, conflicts fail closed, and reload is deterministic', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-ledger-'));
  try {
    const value = observation('auto', '333333333333333333333333'), ledger = new DelegationEvaluationLedger(directory);
    const first = await ledger.append(value, corpus()), repeated = await ledger.append(structuredClone(value), corpus());
    assert.deepEqual(repeated, first); assert.equal((await ledger.load(corpus())).length, 1);
    const conflict = structuredClone(value); conflict.quality.score = 91; seal(conflict);
    await assert.rejects(ledger.append(conflict, corpus()), /conflicts/);
    const reloaded = new DelegationEvaluationLedger(directory); assert.deepEqual(await reloaded.load(corpus()), [first]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('paired projections preserve partial/unavailable usage and never infer a completed pair', () => {
  const auto = observation('auto', '333333333333333333333333', 'partial'), solo = observation('solo', '444444444444444444444444', 'available');
  let projection = projectDelegationEvaluationLedger(corpus(), [auto]);
  assert.equal(projection[0]?.complete, false); assert.equal(projection[0]?.usageCoverage, 'partial');
  projection = projectDelegationEvaluationLedger(corpus(), [solo, auto]);
  assert.equal(projection[0]?.complete, true); assert.equal(projection[0]?.usageCoverage, 'partial'); assert.equal(projection[0]?.quality, 'available');
  const unknown = observation('solo', '444444444444444444444444', 'unavailable');
  projection = projectDelegationEvaluationLedger(corpus(), [auto, unknown]);
  assert.equal(projection[0]?.usageCoverage, 'unavailable');
});

test('conflicting mode or pair bindings fail closed', () => {
  const first = observation('auto', '333333333333333333333333'), second = observation('auto', '444444444444444444444444');
  assert.throws(() => projectDelegationEvaluationLedger(corpus(), [first, second]), /conflicting mode evidence/);
  const wrongPair = structuredClone(observation('solo', '444444444444444444444444')); wrongPair.descriptor.caseSha256 = 'b'.repeat(64); seal(wrongPair);
  assert.throws(() => projectDelegationEvaluationLedger(corpus(), [first, wrongPair]), /immutable corpus case/);
});

test('ledger storage refuses a symlink or oversized bytes before parsing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-ledger-'));
  try {
    const ledger = new DelegationEvaluationLedger(directory), file = path.join(directory, 'delegation-evaluation-ledger.json'), target = path.join(directory, 'outside.json');
    await writeFile(target, JSON.stringify({ version: 1, observations: [] }));
    try { await symlink(target, file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation is unavailable in this Windows test environment'); return; } throw error; }
    await assert.rejects(ledger.load(corpus()), /storage/); await rm(file);
    await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(ledger.load(corpus()), /storage|size bound/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('two ledger instances serialize concurrent appends without losing either observation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-ledger-'));
  try {
    const first = new DelegationEvaluationLedger(directory), second = new DelegationEvaluationLedger(directory);
    const [left, right] = await Promise.allSettled([first.append(observation('auto', '333333333333333333333333'), corpus()), second.append(observation('solo', '444444444444444444444444'), corpus())]);
    assert.ok([left, right].some(item => item.status === 'fulfilled'));
    for (const [result, ledger, value] of [[left, first, observation('auto', '333333333333333333333333')], [right, second, observation('solo', '444444444444444444444444')]] as const) {
      if (result.status === 'rejected') { assert.match(String(result.reason), /another writer|retained lock/); await ledger.append(value, corpus()); }
    }
    assert.equal((await new DelegationEvaluationLedger(directory).load(corpus())).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a retained ledger lock fails closed instead of being reclaimed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-ledger-'));
  try {
    await writeFile(path.join(directory, 'delegation-evaluation-ledger.json.lock'), 'unknown-owner');
    await assert.rejects(new DelegationEvaluationLedger(directory).append(observation('auto', '333333333333333333333333'), corpus()), /another writer|retained lock/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
