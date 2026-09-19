import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAutoDelegationParentResume, type AutoDelegationParentResumeChild, type AutoDelegationParentResumeResultRecord } from '../src/core/autoDelegationParentResume';
import { prepareDelegationResult } from '../src/core/delegationResults';

const parentId = '111111111111', runId = '222222222222', baseCommit = 'a'.repeat(40);
const child = (childKey: string, dispatchKey: string, state: 'finished' | 'failed' = 'finished'): AutoDelegationParentResumeChild => ({ parentId, runId, childKey, dispatchKey, state });
const record = (item: AutoDelegationParentResumeChild, unresolved: string[] = []): AutoDelegationParentResumeResultRecord => {
  const binding = { parentId, runId, childKey: item.childKey, dispatchKey: item.dispatchKey, baseCommit, writeScope: ['src'], dependencies: [] };
  return { binding, receipt: prepareDelegationResult({ version: 1, parentId, runId, childKey: item.childKey, dispatchKey: item.dispatchKey, baseCommit, commit: 'b'.repeat(39) + item.childKey.length, tree: 'c'.repeat(39) + item.childKey.length, changedPaths: ['src/example.ts'], decisions: 'Kept the bounded contract.', summary: `${item.childKey} completed its assigned work.`, unresolved, validations: [], evidence: [], dependencies: [] }, binding) };
};
const hashes = (records: AutoDelegationParentResumeResultRecord[]) => records.map(item => (item.receipt as { sha256: string }).sha256).sort();
const key = (receiptSha256s: string[]) => createHash('sha256').update(receiptSha256s.join('\n')).digest('hex');
const input = (children: AutoDelegationParentResumeChild[], results: AutoDelegationParentResumeResultRecord[], snapshot = results) => {
  const receiptSha256s = hashes(snapshot);
  return { wakeup: { version: 1 as const, parentId, runId, receiptSha256s, wakeupKey: key(receiptSha256s) }, children, results };
};

test('simultaneous child results coalesce into sorted bounded receipt references and caveats', () => {
  const first = child('first', '1'.repeat(24)), second = child('second', '2'.repeat(24));
  const result = createAutoDelegationParentResume(input([first, second], [record(second, ['Needs parent choice.']), record(first)]));
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.deepEqual(result.payload.resultReferences.map(reference => reference.childKey), ['first', 'second']);
    assert.deepEqual(result.payload.unresolvedCaveats, ['second: Needs parent choice.']);
    assert.match(result.payload.content, /receipt [a-f0-9]{64}/);
    assert.doesNotMatch(result.payload.content, /transcript|stdout|stderr/i);
  }
});

test('replaying the same saved wakeup and receipts is a pure no-op', () => {
  const first = child('first', '1'.repeat(24)), second = child('second', '2'.repeat(24));
  const saved = input([first, second], [record(first), record(second)]);
  assert.deepEqual(createAutoDelegationParentResume(saved), createAutoDelegationParentResume(structuredClone(saved)));
});

test('an incomplete saved receipt snapshot or failed child blocks continuation', () => {
  const first = child('first', '1'.repeat(24)), second = child('second', '2'.repeat(24));
  const firstResult = record(first), secondResult = record(second);
  const missing = createAutoDelegationParentResume(input([first, second], [firstResult], [firstResult, secondResult]));
  assert.deepEqual(missing, { status: 'blocked', reason: 'incomplete-wakeup-snapshot', receiptSha256s: hashes([secondResult]) });
  const failed = createAutoDelegationParentResume(input([first, child('second', '2'.repeat(24), 'failed')], [record(first)]));
  assert.deepEqual(failed, { status: 'blocked', reason: 'failed-child', childKeys: ['second'] });
});

test('a saved partial wakeup stays bound to its receipt snapshot after a later child result arrives', () => {
  const first = child('first', '1'.repeat(24)), second = child('second', '2'.repeat(24));
  const firstResult = record(first), secondResult = record(second);
  const saved = input([first, second], [firstResult], [firstResult]);
  const initial = createAutoDelegationParentResume(saved);
  const afterSecondArrival = createAutoDelegationParentResume({ ...saved, results: [firstResult, secondResult] });
  assert.equal(initial.status, 'ready'); assert.equal(afterSecondArrival.status, 'ready');
  if (initial.status === 'ready' && afterSecondArrival.status === 'ready') {
    assert.deepEqual(afterSecondArrival.payload.resultReferences.map(reference => reference.childKey), ['first']);
    assert.equal(afterSecondArrival.payload.resumeId, initial.payload.resumeId);
    assert.equal(afterSecondArrival.payload.wakeupKey, saved.wakeup.wakeupKey);
  }
});

test('restart round trip preserves the resume identity and wakeup binding', () => {
  const first = child('first', '1'.repeat(24)), second = child('second', '2'.repeat(24));
  const saved = input([first, second], [record(first), record(second)]);
  const initial = createAutoDelegationParentResume(saved), restarted = createAutoDelegationParentResume(JSON.parse(JSON.stringify(saved)));
  assert.equal(initial.status, 'ready'); assert.equal(restarted.status, 'ready');
  if (initial.status === 'ready' && restarted.status === 'ready') assert.equal(initial.payload.resumeId, restarted.payload.resumeId);
});

test('a stale wakeup key or receipt outside a saved child cannot resume the parent', () => {
  const first = child('first', '1'.repeat(24)), foreign = child('foreign', '3'.repeat(24));
  const stale = input([first], [record(first)]); stale.wakeup.wakeupKey = '0'.repeat(64);
  assert.deepEqual(createAutoDelegationParentResume(stale), { status: 'blocked', reason: 'wakeup-mismatch' });
  const firstResult = record(first), foreignResult = record(foreign);
  assert.deepEqual(createAutoDelegationParentResume(input([first], [firstResult, foreignResult], [firstResult, foreignResult])), { status: 'blocked', reason: 'invalid-input', childKeys: ['foreign'] });
});
