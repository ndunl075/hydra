import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDelegatedVerificationGate, validateDelegatedVerificationEvidence, type DelegatedVerificationEvidence } from '../src/core/delegationEvidence';
import type { Task } from '../src/core/model';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40), base = 'c'.repeat(40);
const task = (): Pick<Task, 'delegation' | 'reviewedCommit' | 'verificationEvidence'> => ({
  delegation: { parentId: '111111111111', runId: '222222222222', childKey: 'checks', dispatchKey: 'd'.repeat(24), dependencies: [] },
  reviewedCommit: { commit, tree, baseCommit: base, reviewedAt: '2026-01-01T00:00:00.000Z' }
});
const evidence = (change: Partial<DelegatedVerificationEvidence['attempts'][number]['checks'][number]> = {}): DelegatedVerificationEvidence => ({
  version: 1,
  attempts: [{ id: '1'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', findings: [{ id: 'review-1', severity: 'info', status: 'resolved', summary: 'No blocking findings.' }], checks: [{ id: 'unit', required: true, status: 'passed', command: { executable: 'node', args: ['--test'] }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, artifacts: [{ kind: 'log', path: 'evidence/unit.log', label: 'unit output' }], ...change }] }]
});

test('a delegated child requires an exact passing evidence receipt before integration completion', () => {
  const child = task();
  assert.throws(() => assertDelegatedVerificationGate(child), /requires retained/);
  child.verificationEvidence = evidence();
  assert.doesNotThrow(() => assertDelegatedVerificationGate(child));
});

test('required verification blocks unavailable runners, interruption, failure, and absent artifacts', () => {
  for (const [change, expected] of [
    [{ status: 'unavailable', command: undefined, exitCode: undefined }, /runner is unavailable/],
    [{ status: 'interrupted', exitCode: null }, /was interrupted/],
    [{ status: 'failed', exitCode: 3 }, /did not pass/],
    [{ artifacts: [] }, /missing artifacts/]
  ] as Array<[Partial<DelegatedVerificationEvidence['attempts'][number]['checks'][number]>, RegExp]>) {
    const child = task(); child.verificationEvidence = evidence(change);
    assert.throws(() => assertDelegatedVerificationGate(child), expected);
  }
});

test('stale snapshots and malformed retry history cannot pass a delegated completion gate', () => {
  const child = task(); child.verificationEvidence = evidence();
  child.verificationEvidence.attempts[0]!.checkedTree = 'd'.repeat(40);
  assert.throws(() => assertDelegatedVerificationGate(child), /stale/);
  const bad = evidence(); bad.attempts.push({ ...structuredClone(bad.attempts[0]!), id: '2'.repeat(24), number: 3 });
  assert.throws(() => validateDelegatedVerificationEvidence(bad), /attempt/);
});

test('malformed commands and non-portable artifact references report validation errors', () => {
  const malformed = evidence();
  malformed.attempts[0]!.checks[0]!.command = { args: [] } as unknown as { executable: string; args: string[] };
  assert.throws(() => validateDelegatedVerificationEvidence(malformed), /Invalid delegated verification command/);

  for (const path of ['C:unit.log', 'C:/unit.log', '/tmp/unit.log', '\\\\server\\share\\unit.log', 'file:///tmp/unit.log', 'evidence:unit.log', 'evidence/../unit.log', 'evidence\\unit.log', 'evidence//unit.log']) {
    const invalid = evidence();
    invalid.attempts[0]!.checks[0]!.artifacts[0]!.path = path;
    assert.throws(() => validateDelegatedVerificationEvidence(invalid), /Invalid delegated verification artifact/, path);
  }
});

test('timestamps are real UTC instants and retries cannot overlap or precede their prior attempt', () => {
  const impossibleDate = evidence();
  impossibleDate.attempts[0]!.finishedAt = '2026-02-30T00:01:00.000Z';
  assert.throws(() => validateDelegatedVerificationEvidence(impossibleDate), /Invalid delegated verification attempt/);

  const outsideAttempt = evidence();
  outsideAttempt.attempts[0]!.checks[0]!.finishedAt = '2026-01-01T00:02:00.000Z';
  assert.throws(() => validateDelegatedVerificationEvidence(outsideAttempt), /timestamps fall outside/);

  const overlappingRetry = evidence();
  overlappingRetry.attempts.push({ ...structuredClone(overlappingRetry.attempts[0]!), id: '2'.repeat(24), number: 2, startedAt: '2026-01-01T00:00:30.000Z', finishedAt: '2026-01-01T00:01:30.000Z' });
  assert.throws(() => validateDelegatedVerificationEvidence(overlappingRetry), /retry chronology/);
});

test('an attempt with only optional checks records no child-level gate and still requires combined integration acceptance', () => {
  const child = task();
  child.verificationEvidence = evidence({ required: false, status: 'not-applicable', command: undefined, exitCode: undefined });
  assert.doesNotThrow(() => assertDelegatedVerificationGate(child));
});

test('only the latest valid retry supplies the current required-check receipt', () => {
  const child = task();
  const history = evidence({ status: 'failed', exitCode: 1 });
  const latest = structuredClone(history.attempts[0]!);
  latest.id = '2'.repeat(24);
  latest.number = 2;
  latest.startedAt = '2026-01-01T00:02:00.000Z';
  latest.finishedAt = '2026-01-01T00:03:00.000Z';
  latest.checks[0]!.status = 'passed';
  latest.checks[0]!.exitCode = 0;
  latest.checks[0]!.startedAt = latest.startedAt;
  latest.checks[0]!.finishedAt = latest.finishedAt;
  history.attempts.push(latest);
  child.verificationEvidence = history;
  assert.doesNotThrow(() => assertDelegatedVerificationGate(child));
});

test('attempt identifiers are unique across retained retry history', () => {
  const history = evidence();
  const retry = structuredClone(history.attempts[0]!);
  retry.number = 2;
  retry.startedAt = '2026-01-01T00:02:00.000Z';
  retry.finishedAt = '2026-01-01T00:03:00.000Z';
  retry.checks[0]!.startedAt = retry.startedAt;
  retry.checks[0]!.finishedAt = retry.finishedAt;
  history.attempts.push(retry);
  assert.throws(() => validateDelegatedVerificationEvidence(history), /Invalid delegated verification attempt/);
});

test('a retry cannot omit or downgrade a previously required check', () => {
  for (const mutation of [
    (retry: DelegatedVerificationEvidence['attempts'][number]) => { retry.checks = [{ ...retry.checks[0]!, id: 'lint', required: false }]; },
    (retry: DelegatedVerificationEvidence['attempts'][number]) => { retry.checks[0]!.required = false; }
  ]) {
    const history = evidence();
    const retry = structuredClone(history.attempts[0]!);
    retry.id = '2'.repeat(24);
    retry.number = 2;
    retry.startedAt = '2026-01-01T00:02:00.000Z';
    retry.finishedAt = '2026-01-01T00:03:00.000Z';
    retry.checks[0]!.startedAt = retry.startedAt;
    retry.checks[0]!.finishedAt = retry.finishedAt;
    mutation(retry);
    if (retry.checks[0]) {
      retry.checks[0]!.startedAt = retry.startedAt;
      retry.checks[0]!.finishedAt = retry.finishedAt;
    }
    history.attempts.push(retry);
    assert.throws(() => validateDelegatedVerificationEvidence(history), /omitted a previously required check/);
  }
});
