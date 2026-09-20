import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/core/worktrees';
import { parseDelegatedVerificationChecks, recordDelegatedVerification, runDelegatedVerificationCommand } from '../src/core/delegationVerification';
import { DelegatedVerificationActionGate, interruptLatestDelegatedVerification, persistDelegatedVerification } from '../src/core/delegationVerificationTransaction';
import type { Task } from '../src/core/model';

async function fixture() {
  const root = await mkdtemp(path.resolve('.test-build/delegation-verification-')); const worktree = path.join(root, 'child'); const storage = path.join(root, 'storage'); await mkdir(worktree);
  await git(worktree, ['init', '-b', 'child']); await git(worktree, ['config', 'user.email', 'verification@example.invalid']); await git(worktree, ['config', 'user.name', 'Verification Test']); await writeFile(path.join(worktree, 'keep.txt'), 'reviewed\n'); await git(worktree, ['add', '.']); await git(worktree, ['commit', '-m', 'reviewed']);
  const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim(), tree = (await git(worktree, ['rev-parse', 'HEAD^{tree}'])).trim();
  const task: Pick<Task, 'id' | 'worktree' | 'delegation' | 'reviewedCommit' | 'verificationEvidence'> = { id: '111111111111', worktree, delegation: { parentId: '222222222222', runId: '333333333333', childKey: 'checks', dispatchKey: 'a'.repeat(24), dependencies: [] }, reviewedCommit: { commit, tree, baseCommit: commit, reviewedAt: '2026-01-01T00:00:00.000Z' } };
  return { root, storage, task };
}
const command = (id: string, source: string, required = true, timeoutMs = 5000) => ({ id, required, timeoutMs, command: { executable: process.execPath, args: ['-e', source] } });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(file); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await wait(20);
  }
  throw new Error('Verification fixture process did not start.');
}

test('records full logs for exact passing and failing checks', async () => { const f = await fixture(); try { const evidence = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('pass', "process.stdout.write('pass')"), command('fail', 'process.exit(7)')] }); assert.deepEqual(evidence.attempts[0]!.checks.map(c => [c.status, c.exitCode]), [['passed', 0], ['failed', 7]]); assert.match(await readFile(path.join(f.storage, ...evidence.attempts[0]!.checks[0]!.artifacts[0]!.path.split('/')), 'utf8'), /pass/); } finally { await rm(f.root, { recursive: true, force: true }); } });
test('fails closed for unavailable runner, pre-abort, and malformed shell-shaped command', async () => { const f = await fixture(); try { const missing = await recordDelegatedVerification(f.storage, { task: f.task, checks: [{ id: 'missing', required: true, timeoutMs: 5000, command: { executable: 'hydra-no-such-runner', args: [] } }] }); assert.equal(missing.attempts[0]!.checks[0]!.status, 'unavailable'); const controller = new AbortController(); controller.abort(); const marker = path.join(f.root, 'marker'); const aborted = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('abort', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)], signal: controller.signal }); assert.equal(aborted.attempts[0]!.checks[0]!.status, 'interrupted'); await assert.rejects(readFile(marker)); assert.throws(() => parseDelegatedVerificationChecks([{ id: 'unsafe', required: true, timeoutMs: 5000, command: { executable: 'npm.cmd', args: ['test & echo bad'] } }]), /shell|character|shim/i); } finally { await rm(f.root, { recursive: true, force: true }); } });
test('preserves immutable prior attempts and required retry preflight', async () => { const f = await fixture(); try { const first = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] }); f.task.verificationEvidence = first; const second = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] }); const interrupted = interruptLatestDelegatedVerification(second); assert.equal(interrupted.attempts[0]!.checks[0]!.status, 'passed'); assert.equal(interrupted.attempts[1]!.checks[0]!.status, 'interrupted'); f.task.verificationEvidence = first; await assert.rejects(recordDelegatedVerification(f.storage, { task: f.task, checks: [command('other', 'process.exit(0)')] }), /omitted previously required/); } finally { await rm(f.root, { recursive: true, force: true }); } });
test('refuses a new reviewed result without replacing immutable evidence from the earlier result', async () => { const f = await fixture(); try {
  const first = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] }); f.task.verificationEvidence = structuredClone(first);
  await writeFile(path.join(f.task.worktree, 'keep.txt'), 'new reviewed result\n'); await git(f.task.worktree, ['add', '.']); await git(f.task.worktree, ['commit', '-m', 'new reviewed result']);
  const commit = (await git(f.task.worktree, ['rev-parse', 'HEAD'])).trim(), tree = (await git(f.task.worktree, ['rev-parse', 'HEAD^{tree}'])).trim(); f.task.reviewedCommit = { commit, tree, baseCommit: first.attempts[0]!.checkedCommit, reviewedAt: '2026-01-02T00:00:00.000Z' };
  await assert.rejects(recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] }), /earlier reviewed result/);
  assert.deepEqual(f.task.verificationEvidence, first, 'The earlier result history remains available for a future explicit boundary/archive.');
} finally { await rm(f.root, { recursive: true, force: true }); } });
test('cancels the owned runner and rolls back a failed durable transaction', async () => { const f = await fixture(); try { const controller = new AbortController(); const marker = path.join(f.root, 'started'); const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');setInterval(()=>{},1000)`; const pending = recordDelegatedVerification(f.storage, { task: f.task, checks: [command('hang', source)], signal: controller.signal }); for (let i = 0; i < 50; i++) { try { await readFile(marker); break; } catch { await new Promise(r => setTimeout(r, 20)); } } controller.abort(); const evidence = await pending; assert.equal(evidence.attempts[0]!.checks[0]!.status, 'interrupted'); const task: Pick<Task, 'verificationEvidence' | 'updatedAt'> = { verificationEvidence: evidence, updatedAt: '2026-01-01T00:00:00.000Z' }; await assert.rejects(persistDelegatedVerification(task, interruptLatestDelegatedVerification(evidence), async () => { throw new Error('disk unavailable'); }, '2026-01-02T00:00:00.000Z'), /disk unavailable/); assert.deepEqual(task.verificationEvidence, evidence); } finally { await rm(f.root, { recursive: true, force: true }); } });
test('action gate fences shutdown until its active operation settles', async () => { const gate = new DelegatedVerificationActionGate(); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const action = gate.start(async signal => { signal.addEventListener('abort', release, { once: true }); await pending; }); assert.throws(() => gate.start(async () => {}), /already in progress/); await gate.abortAndWait(); await action.done; });
test('termination denial has a bounded interrupted fallback instead of hanging a shutdown', async () => { const f = await fixture(); try {
  const controller = new AbortController(), marker = path.join(f.root, 'termination-denied.log'), ready = path.join(f.root, 'termination-denied.ready');
  const pending = runDelegatedVerificationCommand({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(() => {}, 1000)`] }, f.task.worktree, marker, controller.signal, async () => { throw new Error('taskkill access denied'); }, 20);
  await waitForFile(ready); controller.abort(); const result = await pending;
  assert.deepEqual(result, { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: true });
  assert.match(await readFile(marker, 'utf8'), /could not confirm process-tree termination/i);
  await wait(150);
} finally { await rm(f.root, { recursive: true, force: true }); } });
test('a never-settling process-tree cleanup is bounded and leaves an interrupted uncertainty record', async () => { const f = await fixture(); try {
  const controller = new AbortController(), marker = path.join(f.root, 'termination-hung.log'), ready = path.join(f.root, 'termination-hung.ready');
  const pending = runDelegatedVerificationCommand({ executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(() => {}, 1000)`] }, f.task.worktree, marker, controller.signal, async () => await new Promise<void>(() => {}), 20);
  await waitForFile(ready); controller.abort(); const result = await pending;
  assert.deepEqual(result, { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: true });
  assert.match(await readFile(marker, 'utf8'), /cleanup exceeded 20ms.*writer ownership is uncertain/i);
  await wait(150);
} finally { await rm(f.root, { recursive: true, force: true }); } });
test('an explicit command timeout retains failed evidence and stops the owned runner', async () => { const f = await fixture(); try {
  const evidence = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('timeout', 'setInterval(() => {}, 1000)', true, 1000)] });
  const check = evidence.attempts[0]!.checks[0]!; assert.equal(check.status, 'failed'); assert.equal(check.exitCode, null); assert.match(await readFile(path.join(f.storage, ...check.artifacts[0]!.path.split('/')), 'utf8'), /timed out after 1000ms/i);
} finally { await rm(f.root, { recursive: true, force: true }); } });
test('a long-running command is stopped promptly when its log writer fails', async () => { const f = await fixture(); try {
  const fake = { write: async () => { throw new Error('disk full'); }, close: async () => {} } as any;
  const result = await runDelegatedVerificationCommand({ executable: process.execPath, args: ['-e', "process.stdout.write('x');setTimeout(() => process.exit(), 100)"] }, f.task.worktree, path.join(f.root, 'fake.log'), undefined, async () => {}, 20, 1000, async () => fake);
  assert.deepEqual(result, { exitCode: null, unavailable: false, interrupted: false, timedOut: false, logFailed: true, logged: false });
  await wait(150);
} finally { await rm(f.root, { recursive: true, force: true }); } });
test('shutdown during the first durable save persists an interrupted latest attempt for reload', async () => {
  const f = await fixture(); try {
    const evidence = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] });
    const task: Pick<Task, 'verificationEvidence' | 'updatedAt'> = { updatedAt: '2026-01-01T00:00:00.000Z' }; const controller = new AbortController(); const snapshots: any[] = [];
    let entered!: () => void, release!: () => void; const firstEntered = new Promise<void>(resolve => { entered = resolve; }), firstRelease = new Promise<void>(resolve => { release = resolve; });
    let saves = 0; const pending = persistDelegatedVerification(task, evidence, async () => { snapshots.push(structuredClone(task.verificationEvidence)); if (++saves === 1) { entered(); await firstRelease; } }, '2026-01-02T00:00:00.000Z', controller.signal);
    await firstEntered; controller.abort(); release(); const persisted = await pending;
    assert.equal(snapshots.length, 2, 'The completed first snapshot is followed by an interruption snapshot.');
    assert.equal(snapshots[0]!.attempts.at(-1)!.checks[0]!.status, 'passed'); assert.equal(snapshots[1]!.attempts.at(-1)!.checks[0]!.status, 'interrupted');
    assert.equal(persisted.attempts.at(-1)!.checks[0]!.status, 'interrupted'); assert.equal(task.verificationEvidence!.attempts.at(-1)!.checks[0]!.status, 'interrupted');
    const reloaded = structuredClone(snapshots.at(-1)); assert.equal(reloaded.attempts.at(-1)!.checks[0]!.status, 'interrupted', 'A reload observes the final durable interruption state.');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('an abort delivered after the first save but before action completion overwrites a passing record', async () => { const f = await fixture(); try {
  const evidence = await recordDelegatedVerification(f.storage, { task: f.task, checks: [command('unit', 'process.exit(0)')] }); const task: Pick<Task, 'verificationEvidence' | 'updatedAt'> = { updatedAt: '2026-01-01T00:00:00.000Z' }; const controller = new AbortController(); const snapshots: any[] = [];
  let saves = 0; const persisted = await persistDelegatedVerification(task, evidence, async () => { snapshots.push(structuredClone(task.verificationEvidence)); if (++saves === 1) queueMicrotask(() => controller.abort()); }, '2026-01-02T00:00:00.000Z', controller.signal);
  assert.equal(snapshots.length, 2); assert.equal(persisted.attempts.at(-1)!.checks[0]!.status, 'interrupted'); assert.equal(snapshots.at(-1)!.attempts.at(-1)!.checks[0]!.status, 'interrupted');
} finally { await rm(f.root, { recursive: true, force: true }); } });
