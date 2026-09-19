import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { DelegatedVerificationEvidence } from '../src/core/delegationEvidence';
import { DelegationParentReviewJournal, assertCurrentParentReviewApproved, type ParentReviewSource } from '../src/core/delegationParentReview';
import { prepareDelegationResult } from '../src/core/delegationResults';

const now = '2026-09-19T00:00:00.000Z', later = '2026-09-19T00:01:00.000Z';
const parentId = '111111111111', runId = '222222222222', commit = 'b'.repeat(40), tree = 'c'.repeat(40);
const evidence = (): DelegatedVerificationEvidence => ({ version: 1, attempts: [{ id: 'e'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: now, finishedAt: now, findings: [], checks: [{ id: 'focused', required: true, status: 'passed', command: { executable: 'npm.cmd', args: ['test'] }, finishedAt: now, exitCode: 0, artifacts: [{ kind: 'log', path: 'delegation-evidence/child/focused.log', label: 'Focused test output' }] }] }] });
function source(): ParentReviewSource { const binding = { parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), baseCommit: 'a'.repeat(40), writeScope: ['src'], dependencies: [] }; const result = prepareDelegationResult({ version: 1, parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), baseCommit: 'a'.repeat(40), commit, tree, changedPaths: ['src/example.ts'], decisions: 'Kept the result compact.', summary: 'Child completed its reviewed change.', unresolved: [], validations: [], evidence: [], dependencies: [] }, binding); return { child: { delegation: { parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), dependencies: [] }, reviewedCommit: { commit, tree, baseCommit: 'a'.repeat(40), reviewedAt: now }, verificationEvidence: evidence() }, binding, result }; }
const review = (current: ParentReviewSource, decision: 'approved' | 'rejected' = 'approved') => ({ version: 1, parentId, runId, childKey: 'child-1', resultSha256: current.result.sha256, evidenceSha256: undefined as unknown, commit, tree, reviewer: 'parent-human', decision, reviewedAt: later, reason: decision === 'approved' ? 'Reviewed the child diff and required evidence.' : 'The combined contract remains incomplete.' });
async function fixture() { return { directory: await mkdtemp(path.join(tmpdir(), 'hydra-parent-review-')) }; }

test('persists one exact explicit human approval and replays it deterministically after restart', async () => {
  const f = await fixture(); try {
    const current = source(), journal = new DelegationParentReviewJournal(f.directory); const value = review(current); value.evidenceSha256 = requireEvidence(current);
    const first = await journal.append(value, current), duplicate = await journal.append(value, current);
    assert.equal(duplicate.sha256, first.sha256); assert.equal((await journal.load(parentId, runId)).length, 1);
    const restarted = new DelegationParentReviewJournal(f.directory); assert.equal((await restarted.append(value, current)).sha256, first.sha256); assert.equal((await restarted.load(parentId, runId)).length, 1);
    assert.equal(assertCurrentParentReviewApproved(await restarted.load(parentId, runId), current).decision, 'approved');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('refuses model-style approval, stale result/evidence boundaries, and conflicting decisions while retaining prior audit facts', async () => {
  const f = await fixture(); try {
    const current = source(), journal = new DelegationParentReviewJournal(f.directory), accepted = review(current); accepted.evidenceSha256 = requireEvidence(current); await journal.append(accepted, current);
    const model = { ...accepted, reviewer: 'model' }; await assert.rejects(journal.append(model, current), /explicit human/);
    const tampered = source(); tampered.result.summary = 'Changed after its SHA-256 receipt.'; const stale = review(tampered); stale.evidenceSha256 = requireEvidence(tampered); await assert.rejects(journal.append(stale, tampered), /changed.*Do not deliver/i);
    const changedEvidence = source(); changedEvidence.child.verificationEvidence!.attempts[0]!.checks[0]!.artifacts[0]!.label = 'Updated evidence'; const staleEvidence = review(changedEvidence); staleEvidence.evidenceSha256 = requireEvidence(current); await assert.rejects(journal.append(staleEvidence, changedEvidence), /stale or belongs/);
    const conflicting = review(current, 'rejected'); conflicting.evidenceSha256 = requireEvidence(current); await assert.rejects(journal.append(conflicting, current), /Conflicting parent review/);
    assert.equal((await journal.load(parentId, runId)).length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('a durable rejection blocks acceptance and journal save failure preserves the source evidence', async () => {
  const f = await fixture(); try {
    const current = source(), journal = new DelegationParentReviewJournal(f.directory), rejected = review(current, 'rejected'); rejected.evidenceSha256 = requireEvidence(current); await journal.append(rejected, current);
    await assert.rejects(async () => assertCurrentParentReviewApproved(await journal.load(parentId, runId), current), /does not explicitly approve/);
    const failing = new DelegationParentReviewJournal(path.join(f.directory, 'failure'), async () => { throw Error('disk full'); }); const preserved = structuredClone(current); const approval = review(current); approval.evidenceSha256 = requireEvidence(current);
    await assert.rejects(failing.append(approval, current), /disk full/); assert.deepEqual(current, preserved); assert.equal((await failing.load(parentId, runId)).length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('integration seam refuses missing and stale approvals before combined acceptance', () => {
  const current = source(); assert.throws(() => assertCurrentParentReviewApproved([], current), /requires one current/);
  const receipt = { ...review(current), evidenceSha256: requireEvidence(current), sha256: '0'.repeat(64) } as any;
  assert.throws(() => assertCurrentParentReviewApproved([receipt], current), /stale/);
  const pending = { ...review(current), evidenceSha256: requireEvidence(current), decision: 'pending' } as any;
  pending.sha256 = require('node:crypto').createHash('sha256').update(JSON.stringify(pending)).digest('hex');
  assert.throws(() => assertCurrentParentReviewApproved([pending], current), /does not explicitly approve/);
});

function requireEvidence(current: ParentReviewSource): string {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(current.child.verificationEvidence)).digest('hex');
}
