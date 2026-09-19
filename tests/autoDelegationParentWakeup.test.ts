import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareAutoDelegationParentWakeup, saveAutoDelegationParentWaiting } from '../src/core/autoDelegationParentWakeup';
import { prepareParentReviewReceipt } from '../src/core/delegationParentReview';
import { prepareDelegationResult } from '../src/core/delegationResults';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', baseCommit = 'a'.repeat(40), now = '2026-09-19T00:00:00.000Z';
function fixture(childKey: string, digit: string) {
  const commit = digit.repeat(40), tree = 'f'.repeat(39) + digit;
  const child = { id: digit.repeat(12), state: 'idle', schedule: { state: 'finished', dependencies: [], artifacts: [] }, delegation: { parentId, runId, childKey, dispatchKey: digit.repeat(24), dependencies: [] }, reviewedCommit: { commit, tree, baseCommit, reviewedAt: now }, verificationEvidence: { version: 1, attempts: [{ id: 'e'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: now, finishedAt: now, findings: [], checks: [{ id: 'focused', required: true, status: 'passed', command: { executable: 'npm.cmd', args: ['test'] }, finishedAt: now, exitCode: 0, artifacts: [{ kind: 'log', path: 'delegation-evidence/child/focused.log', label: 'Focused test output' }] }] }] } } as unknown as Task;
  const binding = { parentId, runId, childKey, dispatchKey: digit.repeat(24), baseCommit, writeScope: ['src'], dependencies: [] };
  const receipt = prepareDelegationResult({ version: 1, parentId, runId, childKey, dispatchKey: digit.repeat(24), baseCommit, commit, tree, changedPaths: ['src/example.ts'], decisions: 'Kept the bounded change.', summary: `${childKey} finished.`, unresolved: [], validations: [], evidence: [], dependencies: [] }, binding);
  const source = { child, binding, result: receipt };
  const review = prepareParentReviewReceipt({ version: 1, parentId, runId, childKey, resultSha256: receipt.sha256, evidenceSha256: createHash('sha256').update(JSON.stringify(child.verificationEvidence)).digest('hex'), commit, tree, reviewer: 'parent-human', decision: 'approved', reviewedAt: now, reason: 'Reviewed the saved child result.' }, source);
  return { child, record: { binding, receipt }, review, source };
}
const parent = { id: parentId } as Task;

test('two approved saved results coalesce independent of delivery order', () => {
  const first = fixture('first', 'b'), second = fixture('second', 'c');
  const a = prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [first.child, second.child], [second.record, first.record], [first.review, second.review]);
  const b = prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [second.child, first.child], [first.record, second.record], [second.review, first.review]);
  assert.equal(a.status, 'ready'); assert.deepEqual(a, b);
  if (a.status === 'ready') assert.deepEqual(a.payload.resultReferences.map(item => item.childKey), ['first', 'second']);
});

test('failure, missing review, rejection and stale reviewed tree cannot wake the parent', () => {
  const first = fixture('first', 'b'), second = fixture('second', 'c');
  const ready = () => prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [first.child, second.child], [first.record, second.record], [first.review, second.review]);
  assert.equal(ready().status, 'ready');
  second.child.schedule!.state = 'blocked'; assert.equal(ready().status, 'blocked');
  second.child.schedule!.state = 'finished';
  assert.equal(prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [first.child, second.child], [first.record, second.record], [first.review]).status, 'blocked');
  const rejected = prepareParentReviewReceipt({ ...((({ sha256: _sha256, ...rest }) => rest)(second.review)), decision: 'rejected', reason: 'Result does not meet the parent brief.' }, second.source);
  assert.equal(prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [first.child, second.child], [first.record, second.record], [first.review, rejected]).status, 'blocked');
  second.child.reviewedCommit!.tree = '0'.repeat(40); assert.equal(ready().status, 'blocked');
});

test('one materialized child cannot wake a two-child accepted proposal', () => {
  const first = fixture('first', 'b');
  const result = prepareAutoDelegationParentWakeup(parent, runId, ['first', 'second'], [first.child], [first.record], [first.review]);
  assert.equal(result.status, 'blocked');
});

test('parent wait is durable before ownership release and failed save keeps reservation', async () => {
  const task = { id: parentId, provider: 'codex', sessionProvider: 'codex', sessionId: 'session', state: 'idle', schedule: { state: 'running', dependencies: [], artifacts: [], request: { type: 'startManaged' } } } as unknown as Task;
  const events: string[] = [];
  await saveAutoDelegationParentWaiting(task, [task], async tasks => { events.push('save'); assert.equal(tasks[0]!.schedule!.state, 'waiting-for-children'); assert.equal(task.schedule!.state, 'running'); }, () => events.push('hold'));
  events.push('release');
  assert.deepEqual(events, ['save', 'release']);
  assert.equal(task.schedule!.state, 'waiting-for-children');
  task.schedule!.state = 'running';
  await assert.rejects(saveAutoDelegationParentWaiting(task, [task], async () => { events.push('failed-save'); throw new Error('disk failed'); }, () => events.push('hold')));
  assert.deepEqual(events.slice(-2), ['failed-save', 'hold']);
  assert.equal(task.schedule!.state, 'running');
});
