import test from 'node:test';
import assert from 'node:assert/strict';
import type { IntegrationOperation } from '../src/core/integrationModel';
import type { Task } from '../src/core/model';
import { previewTaskArchiveEligibility, type TaskArchiveObservation } from '../src/core/taskArchiveEligibility';

const stamp = '2026-09-19T00:00:00.000Z', id = '123456abcdef', commit = 'a'.repeat(40), tree = 'b'.repeat(40), target = 'c'.repeat(40);
const task = (): Task => ({ id, title: 'Archive preview', prompt: 'No mutation', repository: '/repo', worktree: '/worktree', branch: 'hydra/archive-preview', baseCommit: target, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: stamp, updatedAt: stamp, reviewedCommit: { commit, tree, baseCommit: target, reviewedAt: stamp } });
const operation = (phase: IntegrationOperation['phase'] = 'promoted'): IntegrationOperation => ({ version: 1, id: 'd'.repeat(24), taskId: id, repository: '/repo', taskWorktree: '/worktree', taskBranch: 'hydra/archive-preview', targetBranch: 'main', baseCommit: target, taskCommit: commit, taskTree: tree, targetCommit: target, candidate: '/.hydra-integrations/' + 'd'.repeat(24), candidateCommit: 'e'.repeat(40), candidateTree: 'f'.repeat(40), rollbackRef: 'refs/hydra/integration-backups/' + 'd'.repeat(24), phase, checks: [{ executable: 'npm.cmd', args: ['test'], status: 'passed', exitCode: 0 }], files: [], createdAt: stamp, updatedAt: stamp });
const observed = (): TaskArchiveObservation => ({ savedState: 'clean', ownership: 'stopped', evidence: 'complete' });

test('advises archive only after matching accepted integration and stopped clean ownership, while listing recovery refs', () => {
  const result = previewTaskArchiveEligibility(task(), [task()], [operation()], observed());
  assert.equal(result.eligible, true); assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.recovery.retainedRefs, [{ kind: 'task-branch', ref: 'refs/heads/hydra/archive-preview', commit }, { kind: 'integration-rollback', ref: 'refs/hydra/integration-backups/' + 'd'.repeat(24), commit: target }]);
});

test('blocks dirty, unsaved and unknown checkout observations without treating any as safe', () => {
  for (const savedState of ['dirty', 'unsaved', 'unknown'] as const) {
    const result = previewTaskArchiveEligibility(task(), [task()], [operation()], { ...observed(), savedState });
    assert.equal(result.eligible, false); assert.match(result.blockers.map(blocker => blocker.kind).join(','), /checkout-dirty|unsaved-buffers|checkout-unknown/);
  }
});

test('blocks active or uncertain ownership and does not infer stopped ownership from task state', () => {
  for (const ownership of ['active', 'uncertain', 'unknown'] as const) {
    const result = previewTaskArchiveEligibility(task(), [task()], [operation()], { ...observed(), ownership });
    assert.equal(result.eligible, false); assert.match(result.blockers.map(blocker => blocker.kind).join(','), /ownership-/);
  }
  const running = task(); running.state = 'running';
  assert.equal(previewTaskArchiveEligibility(running, [running], [operation()], observed()).eligible, false);
});

test('blocks missing, mismatched, and pending integration evidence plus unknown evidence', () => {
  assert.match(previewTaskArchiveEligibility(task(), [task()], [], observed()).blockers.map(item => item.kind).join(','), /integration-unaccepted/);
  const mismatch = operation(); mismatch.taskCommit = '9'.repeat(40);
  assert.match(previewTaskArchiveEligibility(task(), [task()], [mismatch], observed()).blockers.map(item => item.kind).join(','), /integration-unaccepted/);
  const pending = previewTaskArchiveEligibility(task(), [task()], [operation('validated')], { ...observed(), evidence: 'unknown' });
  assert.match(pending.blockers.map(item => item.kind).join(','), /integration-unaccepted/); assert.match(pending.blockers.map(item => item.kind).join(','), /evidence-pending/); assert.match(pending.blockers.map(item => item.kind).join(','), /evidence-unknown/);
});

test('refuses promoted operations from a different checkout, branch, repository or base and empty checks', () => {
  for (const [field, value] of [['repository', '/elsewhere'], ['taskWorktree', '/other-worktree'], ['taskBranch', 'other/branch'], ['baseCommit', '9'.repeat(40)]] as const) {
    const stale = { ...operation(), [field]: value };
    assert.equal(previewTaskArchiveEligibility(task(), [task()], [stale], observed()).eligible, false, field);
  }
  const noChecks = { ...operation(), checks: [] };
  assert.equal(previewTaskArchiveEligibility(task(), [task()], [noChecks], observed()).eligible, false);
  assert.equal(previewTaskArchiveEligibility(task(), [task()], [operation()], { savedState: 'clean', ownership: 'stopped' } as TaskArchiveObservation).eligible, false, 'omitted evidence cannot count as complete');
});

test('blocks active dependency consumers, without moving or deleting any checkout', () => {
  const parent = task(); const consumer: Task = { ...task(), id: 'aaaaaaaaaaaa', schedule: { state: 'finished', dependencies: [id], artifacts: [] } };
  const result = previewTaskArchiveEligibility(parent, [parent, consumer], [operation()], observed());
  assert.equal(result.eligible, false); assert.deepEqual(result.blockers.filter(item => item.kind === 'dependent-task').map(item => item.taskId), [consumer.id]);
  assert.equal(parent.worktree, '/worktree');
});
