import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { DelegatedVerificationEvidence } from '../src/core/delegationEvidence';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { DelegationResultIngress } from '../src/core/delegationResultIngress';
import type { Task } from '../src/core/model';

const now = '2026-09-19T00:00:00.000Z', parentId = '111111111111', runId = '222222222222', base = 'a'.repeat(40), commit = 'b'.repeat(40), tree = 'c'.repeat(40);
const binding = (key = 'child-1') => ({ parentId, runId, childKey: key, dispatchKey: 'd'.repeat(24), baseCommit: base, writeScope: ['src'], dependencies: [] });
const dispatch = (key = 'child-1') => ({ version: 1 as const, parentId, runId, childKey: key, dispatchKey: 'd'.repeat(24), worktreeId: '1'.repeat(12), baseCommit: base, status: 'materialized' as const, worktree: 'C:/fixture/child', branch: 'agent/child-111111111111', createdAt: now, updatedAt: now });
const evidence = (status: 'passed' | 'failed' | 'interrupted' = 'passed'): DelegatedVerificationEvidence => ({ version: 1, attempts: [{ id: 'e'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: now, finishedAt: now, findings: [], checks: [{ id: 'focused', required: true, status, command: { executable: 'npm.cmd', args: ['test'] }, finishedAt: now, exitCode: status === 'passed' ? 0 : status === 'failed' ? 1 : null, artifacts: [{ kind: 'log', path: 'delegation-evidence/child/focused.log', label: 'Focused test output' }] }] }] });
const child = (key = 'child-1'): Pick<Task, 'id' | 'baseCommit' | 'delegation' | 'reviewedCommit' | 'verificationEvidence'> => ({ id: '333333333333', baseCommit: base, delegation: { parentId, runId, childKey: key, dispatchKey: 'd'.repeat(24), dependencies: [] }, reviewedCommit: { commit, tree, baseCommit: base, reviewedAt: now }, verificationEvidence: evidence() });
const result = (key = 'child-1') => ({ version: 1, parentId, runId, childKey: key, dispatchKey: 'd'.repeat(24), baseCommit: base, commit, tree, changedPaths: ['src/example.ts'], decisions: 'Kept the result compact.', summary: 'Child completed its reviewed change.', unresolved: [], validations: [{ command: 'npm.cmd test', status: 'passed', evidenceRefs: ['focused-log'] }], evidence: [{ id: 'focused-log', kind: 'test', label: 'Focused test result', path: 'delegation-evidence/child/focused.log', sha256: 'f'.repeat(64) }], dependencies: [] });

async function fixture() { const directory = await mkdtemp(path.join(tmpdir(), 'hydra-result-ingress-')); return { directory, journal: new DelegationOrchestrationJournal(directory) }; }

test('delivers an exact reviewed and verified child receipt, then no-ops on exact replay and restart', async () => {
  const f = await fixture(); try {
    const source = { child: child(), binding: binding(), dispatch: dispatch() }, ingress = new DelegationResultIngress(f.journal);
    const first = await ingress.receive(result(), source), second = await ingress.receive(result(), source);
    assert.equal(second.sha256, first.sha256); assert.equal((await f.journal.load(parentId, runId)).results.length, 1);
    const restarted = new DelegationResultIngress(new DelegationOrchestrationJournal(f.directory));
    assert.equal((await restarted.receive(result(), source)).sha256, first.sha256);
    assert.equal((await f.journal.load(parentId, runId)).results.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('refuses a changed dispatch, old reviewed tree, and failed or interrupted evidence before journal delivery', async () => {
  const f = await fixture(); try {
    const ingress = new DelegationResultIngress(f.journal), source = { child: child(), binding: binding(), dispatch: dispatch() };
    await assert.rejects(ingress.receive(result(), { child: source.child, binding: source.binding }), /durable materialized dispatch/);
    await assert.rejects(ingress.receive(result(), { child: source.child, binding: { ...source.binding, dispatchKey: '0'.repeat(24) } }), /recorded child dispatch/);
    const old = result(); old.tree = '0'.repeat(40); await assert.rejects(ingress.receive(old, source), /commit or tree/);
    for (const status of ['failed', 'interrupted'] as const) { const failed = child(); failed.verificationEvidence = evidence(status); await assert.rejects(ingress.receive(result(), { child: failed, binding: binding(), dispatch: dispatch() }), status === 'failed' ? /did not pass/ : /interrupted/); }
    assert.equal((await f.journal.load(parentId, runId)).results.length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('conflicting delivery is refused and a journal save failure leaves its source receipt unchanged', async () => {
  const f = await fixture(); try {
    const source = { child: child(), binding: binding(), dispatch: dispatch() }, ingress = new DelegationResultIngress(f.journal);
    await ingress.receive(result(), source); const conflict = result(); conflict.summary = 'A different compact summary.';
    await assert.rejects(ingress.receive(conflict, source), /Conflicting child result/);
    const failing = new DelegationResultIngress(new DelegationOrchestrationJournal(f.directory, async () => { throw Error('disk full'); }));
    const other = { child: child('child-2'), binding: binding('child-2'), dispatch: dispatch('child-2') };
    const retained = structuredClone(other.child);
    await assert.rejects(failing.receive(result('child-2'), other), /disk full/);
    assert.deepEqual(other.child, retained);
    assert.equal((await f.journal.load(parentId, runId)).results.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
