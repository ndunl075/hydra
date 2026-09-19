import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegationRunArchive, importDelegationRunArchive, maxDelegationRunArchiveBytes, parseDelegationRunArchive } from '../src/core/delegationRunExport';
import type { Task } from '../src/core/model';

const now = '2026-09-19T00:00:00.000Z', parentId = '111111111111', runId = '222222222222', base = 'a'.repeat(40);
const parent = (): Task => ({ id: parentId, title: 'prompt must never leave the task', prompt: 'SECRET=never-export', repository: 'C:/repo', worktree: 'C:/parent', branch: 'parent', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now });
const child = (): Task => ({ id: '333333333333', title: 'also private', prompt: 'full transcript: forbidden', repository: 'C:/repo', worktree: 'C:/child', branch: 'child', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'interrupted', createdAt: now, updatedAt: now, delegation: { parentId, runId, childKey: 'child', dispatchKey: 'b'.repeat(24), dependencies: [] }, reviewedCommit: { commit: 'c'.repeat(40), tree: 'd'.repeat(40), baseCommit: base, reviewedAt: now }, delegationResultBoundaries: [{ version: 1, prior: { commit: 'e'.repeat(40), tree: 'f'.repeat(40), baseCommit: base }, replacement: { commit: 'c'.repeat(40), tree: 'd'.repeat(40), baseCommit: base }, evidence: { version: 1, attempts: [{ command: 'should-not-export', rawLog: 'nor-this' }] } as any, archivedAt: now }] });
const dependency = (): Task => ({ ...child(), id: '444444444444', title: 'dependent', delegation: { parentId, runId, childKey: 'dependent', dispatchKey: 'c'.repeat(24), dependencies: [] }, delegationResultBoundaries: [] });

test('archive is stable, bounded, and redacts source, transcript, logs, and arbitrary task fields by construction', () => {
  const p = parent(), c = child(), d = dependency(); c.delegation!.dependencies = [d.id];
  const first = createDelegationRunArchive({ parent: p, runId, tasks: [c, d, p], evaluationEvidence: [{ id: '4'.repeat(24), sha256: '5'.repeat(64) }], recovery: { parentId, runId, availability: 'available', journal: 'available', children: [{ taskId: c.id, childKey: 'child', pendingDispatch: false, uncertainWriter: false, cancelled: false, journalRecovery: false, budgetHold: false, restart: 'interrupted' }] } });
  const second = createDelegationRunArchive({ parent: p, runId, tasks: [p, c, d] });
  assert.equal(first.sha256, createDelegationRunArchive({ parent: p, runId, tasks: [d, c, p], evaluationEvidence: [{ id: '4'.repeat(24), sha256: '5'.repeat(64) }], recovery: first.recovery }).sha256);
  const text = JSON.stringify(first); assert.ok(!text.includes('SECRET') && !text.includes('transcript') && !text.includes('rawLog') && !text.includes('should-not-export'));
  assert.deepEqual(parseDelegationRunArchive(text), first);
  assert.equal(second.evaluationEvidence.availability, 'unavailable');
});

test('corrupted, oversized, unknown recovery, and unsupported import refuse without touching a live task', () => {
  const p = parent(), before = JSON.stringify(p), archive = createDelegationRunArchive({ parent: p, runId, tasks: [p, child()] });
  const corrupt = structuredClone(archive); corrupt.children[0]!.state = 'running';
  assert.throws(() => parseDelegationRunArchive(corrupt), /hash mismatch/);
  const corruptHash = structuredClone(archive); corruptHash.sha256 = '0'.repeat(64);
  assert.throws(() => parseDelegationRunArchive(corruptHash), /hash mismatch/);
  assert.throws(() => parseDelegationRunArchive(Buffer.alloc(maxDelegationRunArchiveBytes + 1)), /size bound/);
  assert.throws(() => parseDelegationRunArchive({ ...archive, padding: 'x'.repeat(maxDelegationRunArchiveBytes) }), /size bound/);
  const cycle: any = { ...archive }; cycle.self = cycle;
  assert.throws(() => parseDelegationRunArchive(cycle), /Invalid delegated run archive document/);
  const manyDependencies = child(); manyDependencies.delegation!.dependencies = Array.from({ length: 65 }, () => 'child');
  assert.throws(() => createDelegationRunArchive({ parent: p, runId, tasks: [p, manyDependencies] }), /dependencies/);
  const duplicateDependencies = child(); duplicateDependencies.delegation!.dependencies = ['444444444444', '444444444444'];
  assert.throws(() => createDelegationRunArchive({ parent: p, runId, tasks: [p, duplicateDependencies, dependency()] }), /dependencies/);
  const duplicateBoundary = child(); duplicateBoundary.delegationResultBoundaries!.push(structuredClone(duplicateBoundary.delegationResultBoundaries![0]!));
  assert.throws(() => createDelegationRunArchive({ parent: p, runId, tasks: [p, duplicateBoundary] }), /boundaries/);
  const unknown = structuredClone(archive); unknown.recovery.children = [{ taskId: '999999999999', childKey: 'unknown', pendingDispatch: false, uncertainWriter: false, cancelled: false, journalRecovery: false, budgetHold: false, restart: 'none' }];
  unknown.sha256 = archive.sha256;
  assert.throws(() => parseDelegationRunArchive(unknown), /unknown child/);
  assert.throws(() => importDelegationRunArchive(), /not supported/);
  assert.equal(JSON.stringify(p), before);
});
