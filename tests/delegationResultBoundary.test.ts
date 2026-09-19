import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareSupersededDelegatedResultArchive, validateDelegationResultBoundaries } from '../src/core/delegationResultBoundary';
import { delegationIntegrationGate } from '../src/core/delegationIntegrationGate';
import type { DelegatedVerificationEvidence } from '../src/core/delegationEvidence';
import type { Task } from '../src/core/model';
import { LocalStore } from '../src/core/store';

const oldCommit = 'a'.repeat(40), oldTree = 'b'.repeat(40), currentCommit = 'c'.repeat(40), currentTree = 'd'.repeat(40), base = 'e'.repeat(40);
const evidence = (): DelegatedVerificationEvidence => ({ version: 1, attempts: [{ id: '1'.repeat(24), number: 1, checkedCommit: oldCommit, checkedTree: oldTree, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', findings: [], checks: [{ id: 'unit', required: true, status: 'passed', command: { executable: 'node', args: ['--test'] }, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, artifacts: [{ kind: 'log', path: 'evidence/unit.log', label: 'unit output' }] }] }] });
const child = (): Task => ({ id: '111111111111', title: 'Child', prompt: 'Verify', repository: 'C:\\repo', worktree: 'C:\\repo\\child', branch: 'child', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', delegation: { parentId: '222222222222', runId: '333333333333', childKey: 'child', dispatchKey: '4'.repeat(24), dependencies: [] }, reviewedCommit: { commit: currentCommit, tree: currentTree, baseCommit: base, reviewedAt: '2026-01-01T00:02:00.000Z' }, verificationEvidence: evidence() });
const apply = (task: Task, candidate: ReturnType<typeof prepareSupersededDelegatedResultArchive>) => Object.assign(task, candidate);

test('pure preparation creates a validated detached boundary without changing the live task', () => {
  const task = child(), before = JSON.stringify(task);
  const candidate = prepareSupersededDelegatedResultArchive(task, undefined, '2026-01-01T00:03:00.000Z');
  assert.equal(JSON.stringify(task), before);
  assert.equal(candidate.verificationEvidence, undefined);
  validateDelegationResultBoundaries({ ...task, ...candidate });
  task.verificationEvidence!.attempts[0]!.checks[0]!.artifacts[0]!.label = 'outside mutation';
  assert.equal(candidate.delegationResultBoundaries[0]!.evidence.attempts[0]!.checks[0]!.artifacts[0]!.label, 'unit output');
});

test('exact replay retains the matching older boundary while conflicting or unchanged results fail', () => {
  const task = child(), source = structuredClone(task.verificationEvidence!);
  const first = prepareSupersededDelegatedResultArchive(task, source, '2026-01-01T00:03:00.000Z'); apply(task, first);
  const replay = prepareSupersededDelegatedResultArchive(task, source, '2026-01-01T00:04:00.000Z');
  assert.deepEqual(replay.delegationResultBoundaries[0], first.delegationResultBoundaries[0]);
  assert.equal(replay.delegationResultBoundaries.length, 1);
  const conflict = structuredClone(source); conflict.attempts[0]!.checks[0]!.artifacts[0]!.label = 'different proof';
  assert.throws(() => prepareSupersededDelegatedResultArchive(task, conflict), /Conflicting/);
  const unchanged = child(); unchanged.reviewedCommit = { commit: oldCommit, tree: oldTree, baseCommit: base, reviewedAt: '2026-01-01T00:02:00.000Z' };
  assert.throws(() => prepareSupersededDelegatedResultArchive(unchanged), /requires a changed/);
});

test('a completed archive candidate blocks stale combined acceptance and round-trips through LocalStore', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.test-build', 'result-boundary-'));
  try {
    const store = new LocalStore(directory), task = child(), candidate = prepareSupersededDelegatedResultArchive(task);
    await store.save([{ ...task, ...candidate }]);
    const restarted = (await store.load())[0]!;
    assert.equal(restarted.verificationEvidence, undefined); assert.equal(restarted.delegationResultBoundaries!.length, 1);
    const parent = { ...restarted, id: '222222222222', delegation: undefined, delegationResultBoundaries: undefined };
    assert.throws(() => delegationIntegrationGate(parent, [parent, restarted]), /requires retained verification evidence/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed durable archives and a thirty-third boundary are rejected before a candidate returns', () => {
  const task = child(), candidate = prepareSupersededDelegatedResultArchive(task); apply(task, candidate);
  task.delegationResultBoundaries!.push(structuredClone(task.delegationResultBoundaries![0]!));
  assert.throws(() => validateDelegationResultBoundaries(task), /Duplicate/);
  task.delegationResultBoundaries = Array.from({ length: 32 }, (_, index) => {
    const prior = { commit: index.toString(16).padStart(40, '0'), tree: oldTree, baseCommit: base };
    const retained = structuredClone(candidate.delegationResultBoundaries[0]!);
    retained.prior = prior; retained.evidence.attempts[0]!.id = index.toString(16).padStart(24, '0'); retained.evidence.attempts[0]!.checkedCommit = prior.commit;
    return retained;
  });
  task.verificationEvidence = evidence();
  assert.throws(() => prepareSupersededDelegatedResultArchive(task), /Invalid delegated result-boundary archive/);
});
