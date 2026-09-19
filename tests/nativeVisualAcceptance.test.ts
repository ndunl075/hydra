import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const script = path.join(process.cwd(), 'scripts', 'native-visual-acceptance.mjs');
const load = async () => import(pathToFileURL(script).href);

test('fixture record contains every manual native UI gate and remains pending', async () => {
  const { pendingRecord, requiredObservations, validateRecord } = await load();
  const record = pendingRecord('2026-09-19T00:00:00.000Z');
  assert.equal(record.status, 'human-visual-accessibility-acceptance-pending');
  assert.equal(record.nativeHydraWindowInspected, false);
  assert.deepEqual(record.observations.map((item: { id: string }) => item.id), requiredObservations.map((item: { id: string }) => item.id));
  assert.ok(record.observations.every((item: { status: string; observation: null }) => item.status === 'pending' && item.observation === null));
  assert.deepEqual(validateRecord(record), { canPass: false, failed: [], incomplete: requiredObservations.map((item: { id: string }) => item.id) });
});

test('a missing or failed observation cannot be marked passed', async () => {
  const { pendingRecord, validateRecord } = await load();
  const missingWindow = pendingRecord();
  missingWindow.status = 'passed';
  assert.throws(() => validateRecord(missingWindow), /cannot pass.*native Hydra window/i);

  const failedKeyboard = pendingRecord();
  failedKeyboard.nativeHydraWindowInspected = true;
  for (const item of failedKeyboard.observations) {
    item.status = item.id === 'keyboard-focus' ? 'failed' : 'passed';
    item.observation = item.id === 'keyboard-focus' ? 'Focus was not visible.' : 'Observed in a native Hydra window.';
  }
  failedKeyboard.status = 'passed';
  assert.throws(() => validateRecord(failedKeyboard), /keyboard-focus failed/);
});

test('a fully observed native record is pass-ready, while validation does not create a pass', async () => {
  const { pendingRecord, validateRecord, run } = await load();
  const record = pendingRecord();
  record.nativeHydraWindowInspected = true;
  for (const item of record.observations) { item.status = 'passed'; item.observation = 'Observed by a human in a native Hydra window.'; }
  record.status = 'passed';
  assert.deepEqual(validateRecord(record), { canPass: true, failed: [], incomplete: [] });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydra-native-visual-'));
  const output = path.join(directory, 'fixture.json');
  try {
    await run(['--fixture', '--output', output]);
    const written = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(written.status, 'human-visual-accessibility-acceptance-pending');
    assert.equal(written.nativeHydraWindowInspected, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
