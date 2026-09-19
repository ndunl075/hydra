import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assessAutoDelegationResultReadiness } from '../src/core/autoDelegationResultReadiness';
import { prepareParentReviewReceipt, type ParentReviewSource } from '../src/core/delegationParentReview';
import { prepareDelegationResult } from '../src/core/delegationResults';
import type { Task } from '../src/core/model';

const now = '2026-09-19T00:00:00.000Z', later = '2026-09-19T00:01:00.000Z';
const parentId = '111111111111', runId = '222222222222', commit = 'b'.repeat(40), tree = 'c'.repeat(40);
const verification = () => ({ version: 1 as const, attempts: [{ id: 'e'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: now, finishedAt: now, findings: [], checks: [{ id: 'focused', required: true, status: 'passed' as const, command: { executable: 'npm.cmd', args: ['test'] }, finishedAt: now, exitCode: 0, artifacts: [{ kind: 'log' as const, path: 'delegation-evidence/child/focused.log', label: 'Focused test output' }] }] }] });

function current() {
  const child = { id: '333333333333', state: 'idle', delegation: { parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), dependencies: [] }, reviewedCommit: { commit, tree, baseCommit: 'a'.repeat(40), reviewedAt: now }, verificationEvidence: verification() } as unknown as Task;
  const binding = { parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), baseCommit: 'a'.repeat(40), writeScope: ['src'], dependencies: [] };
  const result = prepareDelegationResult({ version: 1, parentId, runId, childKey: 'child-1', dispatchKey: 'd'.repeat(24), baseCommit: 'a'.repeat(40), commit, tree, changedPaths: ['src/example.ts'], decisions: 'Kept the result compact.', summary: 'Child completed its reviewed change.', unresolved: [], validations: [], evidence: [], dependencies: [] }, binding);
  const source: ParentReviewSource = { child, binding, result };
  const evidenceSha256 = createHash('sha256').update(JSON.stringify(child.verificationEvidence)).digest('hex');
  const review = prepareParentReviewReceipt({ version: 1, parentId, runId, childKey: 'child-1', resultSha256: result.sha256, evidenceSha256, commit, tree, reviewer: 'parent-human', decision: 'approved', reviewedAt: later, reason: 'Reviewed the child diff and required evidence.' }, source);
  return { parent: { id: parentId }, child, source, review };
}

test('projects exact current result evidence and approval as ready for existing integration checks only', () => {
  const value = current();
  const result = assessAutoDelegationResultReadiness({ ...value, parentReviews: [value.review] });
  assert.deepEqual(result, { code: 'ready-for-integration-checks', readyForIntegrationChecks: true, reason: 'The current child result, review boundary, verification evidence, and explicit parent approval match. Existing combined integration checks still decide acceptance.' });
});

test('blocks stale trees, missing evidence, and a source that does not describe the selected child', () => {
  const stale = current(); stale.child.reviewedCommit!.tree = 'f'.repeat(40);
  assert.equal(assessAutoDelegationResultReadiness({ ...stale, parentReviews: [stale.review] }).code, 'stale-result');
  const missing = current(); missing.child.verificationEvidence = undefined;
  assert.equal(assessAutoDelegationResultReadiness({ ...missing, parentReviews: [missing.review] }).code, 'missing-or-invalid-evidence');
  const foreign = current(); foreign.source.binding.childKey = 'other';
  assert.equal(assessAutoDelegationResultReadiness({ ...foreign, parentReviews: [foreign.review] }).code, 'result-source-mismatch');
});

test('blocks a pending writer and treats passed child checks without parent review as pending, never accepted integration', () => {
  const writer = current(); writer.child.schedule = { state: 'waiting-for-children', dependencies: [], artifacts: [], request: { type: 'startManaged' } };
  assert.equal(assessAutoDelegationResultReadiness({ ...writer, parentReviews: [writer.review] }).code, 'pending-writer');
  const childOnly = current();
  const result = assessAutoDelegationResultReadiness({ ...childOnly });
  assert.equal(result.code, 'parent-review-pending');
  assert.equal(result.readyForIntegrationChecks, false);
});

test('blocks rejected and stale parent decisions while retaining a pure, non-promoting result', () => {
  const rejected = current();
  const { sha256: _ignored, ...unsigned } = rejected.review;
  const receipt = prepareParentReviewReceipt({ ...unsigned, decision: 'rejected', reason: 'The combined contract remains incomplete.' }, rejected.source);
  const result = assessAutoDelegationResultReadiness({ ...rejected, parentReviews: [receipt] });
  assert.equal(result.code, 'parent-review-rejected-or-stale');
  assert.equal(result.readyForIntegrationChecks, false);
  const stale = current(); stale.review.tree = 'f'.repeat(40);
  assert.equal(assessAutoDelegationResultReadiness({ ...stale, parentReviews: [stale.review] }).code, 'parent-review-rejected-or-stale');
});
