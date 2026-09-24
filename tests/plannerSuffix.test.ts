import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plannerMarkerPrefix, withoutPlannerMarker } from '../src/core/plannerSuffix';
import { plannerMarker } from '../src/core/delegationPlannerIngestion';
import { executableFingerprint } from '../src/core/providers';

test('the conversation hides the planner receipt line but keeps the reply', () => {
  assert.equal(plannerMarkerPrefix, plannerMarker);
  const reply = 'Hello, Nico!\n\nHYDRA_DELEGATION_V1:{"version":1,"decision":"solo","children":[]}';
  assert.equal(withoutPlannerMarker(reply), 'Hello, Nico!');
  // While streaming, a partial marker line never flashes on screen.
  assert.equal(withoutPlannerMarker('Hello\n\nHYDRA_DELEG'), 'Hello');
  // A reply that only mentions the marker mid-line is left alone.
  assert.equal(withoutPlannerMarker('The HYDRA_DELEGATION_V1: line is internal.'), 'The HYDRA_DELEGATION_V1: line is internal.');
  assert.equal(withoutPlannerMarker(''), '');
});

test('a launch probe is reused only for the identical binary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-fingerprint-'));
  try {
    const binary = path.join(directory, 'claude.exe');
    await writeFile(binary, 'version one');
    const first = await executableFingerprint(binary);
    assert.equal(await executableFingerprint(binary), first);
    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(binary, 'version two, a different size');
    assert.notEqual(await executableFingerprint(binary), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
