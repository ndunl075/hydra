import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeAcceptanceRecord, pendingNativeAcceptanceChecklist } from '../src/core/nativeAcceptanceArtifacts';

const stamp = '2026-09-19T00:00:00.000Z';
const artifact = { id: 'onboarding-shot', kind: 'screenshot', path: 'evidence/onboarding.png', sha256: 'a'.repeat(64), capturedAt: stamp, provenance: { operator: 'Nico', host: 'Windows test VM', method: 'manual-native-observation', sourceCommit: 'b'.repeat(40) } };
test('native acceptance checklist keeps every operator gate pending without automation', () => {
  const checklist = pendingNativeAcceptanceChecklist(stamp);
  assert.deepEqual(checklist.map(record => record.gate), ['onboarding', 'appearance-settings-import', 'focused-workspace-navigation', 'installer-wizard', 'integration-discard']);
  assert.ok(checklist.every(record => record.status === 'pending' && record.artifacts.length === 0));
});
test('native acceptance requires provenance-bound screenshot or log artifacts before verification', () => {
  const verified = parseNativeAcceptanceRecord({ version: 1, gate: 'onboarding', status: 'verified', recordedAt: stamp, operator: 'Nico', artifacts: [artifact] });
  assert.equal(verified.artifacts[0]!.provenance.method, 'manual-native-observation');
  for (const invalid of [
    { ...artifact, provenance: undefined },
    { ...artifact, path: '../outside.png' },
    { ...artifact, sha256: 'A'.repeat(64) },
    { ...artifact, kind: 'report' }
  ]) assert.throws(() => parseNativeAcceptanceRecord({ version: 1, gate: 'onboarding', status: 'verified', recordedAt: stamp, operator: 'Nico', artifacts: [invalid] }));
  assert.throws(() => parseNativeAcceptanceRecord({ version: 1, gate: 'installer-wizard', status: 'verified', recordedAt: stamp, artifacts: [] }), /requires operator-bound artifacts/);
  assert.throws(() => parseNativeAcceptanceRecord({ version: 1, gate: 'installer-wizard', status: 'pending', recordedAt: stamp, artifacts: [artifact] }), /Pending/);
  assert.throws(() => parseNativeAcceptanceRecord({ version: 1, gate: 'onboarding', status: 'verified', recordedAt: stamp, operator: 'Someone else', artifacts: [artifact] }), /operator does not match/);
  assert.throws(() => parseNativeAcceptanceRecord({ version: 1, gate: 'onboarding', status: 'verified', recordedAt: stamp, operator: 'Nico', artifacts: [{ ...artifact, capturedAt: '2026-09-19T00:00:01.000Z' }] }), /cannot predate/);
});
