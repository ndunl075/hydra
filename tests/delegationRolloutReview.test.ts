import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { assessDelegationRolloutReview, createDelegationRolloutReviewPacket, DelegationRolloutReviewStore, parseDelegationRolloutReviewPacket, type DelegationRolloutReviewInput } from '../src/core/delegationRolloutReview';
import { createDelegationRunArchive } from '../src/core/delegationRunExport';
import type { Task } from '../src/core/model';

const stamp = '2026-09-19T00:00:00.000Z', parentId = '111111111111', runId = '222222222222', commit = 'a'.repeat(40);
const ref = { id: 'b'.repeat(24), sha256: 'c'.repeat(64) };
const parent = (): Task => ({ id: parentId, title: 'parent', prompt: 'local only', repository: 'C:/repo', worktree: 'C:/worktree', branch: 'main', baseCommit: commit, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: stamp, updatedAt: stamp });
const archive = (references: typeof ref[] | undefined = [ref]) => createDelegationRunArchive({ parent: parent(), runId, tasks: [parent()], evaluationEvidence: references });
const artifact = (gate: string, letter: string) => ({ id: `${gate}-proof`, kind: 'screenshot' as const, path: `evidence/${gate}.png`, sha256: letter.repeat(64), capturedAt: stamp, provenance: { operator: 'Nico', host: 'Windows VM', method: 'manual-native-observation' as const, sourceCommit: commit } });
const input = (): DelegationRolloutReviewInput => ({
  evaluation: { report: { version: 1, decision: 'eligible-for-human-rollout-review', sampleCount: 1, requiredSamples: 1, pairs: [{ pairId: 'pair_1', caseId: 'case_1', eligible: true, tokenEfficiency: 'improved' }] }, references: [ref] },
  readiness: [{ provider: 'codex', adapter: 'ready', controls: 'ready', template: 'ready', authorization: 'required', ready: false }],
  nativeAcceptance: ['onboarding', 'appearance-settings-import', 'focused-workspace-navigation', 'installer-wizard', 'integration-discard'].map((gate, index) => ({ version: 1 as const, gate: gate as any, status: 'verified' as const, recordedAt: stamp, operator: 'Nico', artifacts: [artifact(gate, 'abcde'[index]!)] })),
  release: { manifestSha256: '9'.repeat(64), sourceCommit: commit, signing: 'verified', manualGates: [{ id: 'distinct-version-upgrade', status: 'verified', evidenceSha256: '8'.repeat(64) }, { id: 'installer-wizard', status: 'verified', evidenceSha256: '7'.repeat(64) }] },
  export: archive(), decision: { outcome: 'approve', operator: 'Nico', decidedAt: stamp, rationale: 'All local evidence reviewed.' }
});

test('a packet binds all review facts, survives parse/restart, and records only an explicit human decision', () => {
  const source = input(), before = structuredClone(source), packet = createDelegationRolloutReviewPacket(source);
  assert.ok(Object.isFrozen(packet) && Object.isFrozen(packet.evaluation));
  assert.deepEqual(parseDelegationRolloutReviewPacket(JSON.parse(JSON.stringify(packet))), packet);
  assert.deepEqual(assessDelegationRolloutReview(packet, source), { approved: true, blockers: [] });
  assert.deepEqual(source, before);
  assert.equal(packet.readiness.reports[0]!.ready, false);
});

test('unavailable exported evaluation references and missing references block approval without losing the packet', () => {
  const source = input(); source.export = archive(undefined); source.evaluation.references = undefined;
  const packet = createDelegationRolloutReviewPacket(source), assessed = assessDelegationRolloutReview(packet, source);
  assert.equal(assessed.approved, false);
  assert.ok(assessed.blockers.some(blocker => /External evaluation evidence is unavailable/.test(blocker)));
  assert.deepEqual(parseDelegationRolloutReviewPacket(packet), packet);
});

test('pending release evidence and passive incomplete readiness remain reviewable but cannot approve', () => {
  const source = input();
  delete source.release.manifestSha256;
  delete source.release.sourceCommit;
  source.release.signing = 'missing';
  source.release.manualGates[0] = { id: 'distinct-version-upgrade', status: 'pending' };
  source.readiness[0]!.authorization = 'missing';
  const packet = createDelegationRolloutReviewPacket(source), blockers = assessDelegationRolloutReview(packet, source).blockers.join('\n');
  assert.deepEqual(parseDelegationRolloutReviewPacket(packet), packet);
  assert.match(blockers, /Release manifest provenance is missing/);
  assert.match(blockers, /Release signing evidence is missing/);
  assert.match(blockers, /Required release manual evidence is incomplete/);
  assert.match(blockers, /Provider readiness facts are incomplete/);
});

test('a forged eligible decision without complete matching samples cannot approve', () => {
  const source = input();
  source.evaluation.report = { version: 1, decision: 'eligible-for-human-rollout-review', sampleCount: 0, requiredSamples: 1, pairs: [] };
  const packet = createDelegationRolloutReviewPacket(source);
  assert.equal(assessDelegationRolloutReview(packet, source).approved, false);
  assert.match(assessDelegationRolloutReview(packet, source).blockers.join('\n'), /lacks complete eligible sample evidence/i);
});

test('native provenance and evidence chronology must match the release before a decision can approve', () => {
  const provenanceMismatch = input(); provenanceMismatch.nativeAcceptance[0]!.artifacts[0]!.provenance.sourceCommit = 'f'.repeat(40);
  const packet = createDelegationRolloutReviewPacket(provenanceMismatch);
  assert.match(assessDelegationRolloutReview(packet, provenanceMismatch).blockers.join('\n'), /native acceptance artifact provenance/i);
  const early = input(); early.decision.decidedAt = '2026-09-18T00:00:00.000Z';
  const earlyPacket = createDelegationRolloutReviewPacket(early);
  assert.match(assessDelegationRolloutReview(earlyPacket, early).blockers.join('\n'), /decision predates native acceptance evidence/i);
});

test('the atomic local store preserves a sealed packet across restart and rejects a conflicting writer', async () => {
  const directory = await mkdtemp(path.resolve('.test-build/rollout-review-'));
  try {
    const first = createDelegationRolloutReviewPacket(input()), store = new DelegationRolloutReviewStore(path.join(directory, 'packet.json'));
    await store.save(first);
    const restarted = new DelegationRolloutReviewStore(path.join(directory, 'packet.json'));
    assert.deepEqual(await restarted.load(), first);
    await assert.rejects(restarted.save(first), /write conflict/);
    await restarted.save(first, first.sha256);
    const changed = createDelegationRolloutReviewPacket({ ...input(), decision: { outcome: 'approve', operator: 'Nico', decidedAt: stamp, rationale: 'A different sealed decision.' } });
    const second = createDelegationRolloutReviewPacket({ ...input(), decision: { outcome: 'approve', operator: 'Nico', decidedAt: stamp, rationale: 'Second writer.' } });
    const concurrent = await Promise.allSettled([store.save(changed, first.sha256), restarted.save(second, first.sha256)]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stale report, artifact, release, export, and evaluation-reference hashes each block a prior approval', () => {
  const source = input(), packet = createDelegationRolloutReviewPacket(source);
  const stale = structuredClone(source);
  stale.evaluation.report.pairs[0]!.tokenEfficiency = 'within-tolerance';
  stale.nativeAcceptance[0]!.artifacts[0]!.sha256 = 'f'.repeat(64);
  stale.release.manifestSha256 = 'e'.repeat(64);
  stale.evaluation.references = [{ ...ref, sha256: 'd'.repeat(64) }];
  stale.export = archive(stale.evaluation.references);
  const blockers = assessDelegationRolloutReview(packet, stale).blockers.join('\n');
  assert.match(blockers, /evaluation report hash is stale/i);
  assert.match(blockers, /native acceptance artifact hashes are stale/i);
  assert.match(blockers, /release provenance is stale/i);
  assert.match(blockers, /delegated-run export hash is stale/i);
  assert.match(blockers, /evaluation evidence references are stale/i);
});

test('corrupted packets and non-approval human decisions fail closed', () => {
  const source = input(), packet = createDelegationRolloutReviewPacket(source), corrupt = structuredClone(packet);
  corrupt.decision.rationale = 'changed';
  assert.throws(() => parseDelegationRolloutReviewPacket(corrupt), /packet hash mismatch/);
  source.decision.outcome = 'reject';
  const rejected = createDelegationRolloutReviewPacket(source);
  assert.equal(assessDelegationRolloutReview(rejected, source).approved, false);
  assert.match(assessDelegationRolloutReview(rejected, source).blockers.join('\n'), /human decision is not approval/i);
  assert.throws(() => parseDelegationRolloutReviewPacket(JSON.stringify({ ...packet, padding: 'x'.repeat(1024 * 1024) })), /size bound/);
});
