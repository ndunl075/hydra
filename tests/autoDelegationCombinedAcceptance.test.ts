import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { admitAutoDelegation } from '../src/core/autoDelegationAdmission';
import { dispatchAcceptedAutoDelegation } from '../src/core/autoDelegationDispatch';
import { prepareAutoDelegationParentWakeup } from '../src/core/autoDelegationParentWakeup';
import { deriveAutoDelegationStopRecoveryIntent } from '../src/core/autoDelegationStopRecovery';
import { createDelegatedChildren, enrollDelegatedChildren } from '../src/core/delegationChildren';
import { digest } from '../src/core/delegationContext';
import { DelegationDispatchStore } from '../src/core/delegationDispatch';
import { delegationIntegrationGate } from '../src/core/delegationIntegrationGate';
import { prepareDelegation, type DelegationPolicy, type DelegationProposal } from '../src/core/delegationPlan';
import { DelegationParentReviewJournal } from '../src/core/delegationParentReview';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { DelegationResultIngress } from '../src/core/delegationResultIngress';
import { projectDelegationReconciliation } from '../src/core/delegationReconciliation';
import { prepareDelegationResult } from '../src/core/delegationResults';
import { Integrations } from '../src/core/integration';
import type { Task } from '../src/core/model';
import { TaskScheduler } from '../src/core/scheduler';
import { LocalStore } from '../src/core/store';
import { createWorktree, git } from '../src/core/worktrees';

const parentId = '111111111111', runId = '222222222222', proposalId = '333333333333';
const now = '2026-09-19T00:00:00.000Z';

test('one disposable repository covers Solo, independent and dependent dispatch, stop, restart, blocked results and combined acceptance', async () => {
  const root = await mkdtemp(path.resolve('.test-build/auto-combined-'));
  try {
    const repository = path.join(root, 'repo');
    await mkdir(repository);
    await git(repository, ['init', '-b', 'main']);
    await git(repository, ['config', 'user.name', 'Hydra Fixture']);
    await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
    await git(repository, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(repository, 'README.md'), 'fixture\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'base']);
    const canonical = await realpath(repository), base = (await git(canonical, ['rev-parse', 'HEAD'])).trim();
    const parentWorktree = await createWorktree(canonical, 'Parent', parentId);
    const parent: Task = { id: parentId, title: 'Parent', prompt: 'Build three modules', repository: canonical, ...parentWorktree, provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now };
    const policy: DelegationPolicy = { parentId, runId, mode: 'auto', level: 0, maxChildren: 3, provider: 'codex', models: [], approvedBases: [base], writeScope: ['src/'], otherOwners: [], context: { userIntent: parent.prompt, qualityTarget: 'Combined checks pass', constraints: ['Keep scope'], instructions: [], interfaces: [], evidence: [], maxTurns: 1, timeoutMs: 300000 } };
    const child = (key: string, dependencies: string[] = []) => ({ key, goal: `Build ${key}`, deliverable: `${key} module`, baseCommit: base, writeScope: [`src/${key}/`], dependencies, acceptance: [`Check ${key}`], testCommands: [], contextRefs: [], provider: 'codex' as const });
    const solo: DelegationProposal = { version: 1, id: proposalId, parentId, runId, decision: 'solo', rationale: 'One localized edit stays with the parent.', children: [] };
    assert.equal(admitAutoDelegation({ proposal: solo, policy, parent, preferences: { mode: 'auto', maxChildren: 3, status: 'preparation' } }).status, 'solo');
    const proposal: DelegationProposal = { version: 1, id: proposalId, parentId, runId, decision: 'delegate', rationale: 'Separate modules with one downstream consumer.', children: [child('alpha'), child('beta'), child('gamma', ['alpha'])] };
    const decision = prepareDelegation(proposal, policy);
    assert.equal(admitAutoDelegation({ proposal, policy, parent, preferences: { mode: 'auto', maxChildren: 3, status: 'preparation' } }).status, 'eligible');
    parent.delegationPlanner = { version: 1, runId, state: 'accepted', policy, preferences: { mode: 'auto', maxChildren: 3, status: 'preparation' }, turnId: '444444444444', proposalId, sha256: digest(JSON.stringify(decision.proposal)) };
    const store = new LocalStore(path.join(root, 'tasks'));
    const dispatches = new DelegationDispatchStore(path.join(root, 'dispatches'), async () => {});
    const resultJournal = new DelegationOrchestrationJournal(path.join(root, 'results'));
    const reviewJournal = new DelegationParentReviewJournal(path.join(root, 'reviews'));
    const ingress = new DelegationResultIngress(resultJournal);
    let tasks = [parent], launches: string[] = [];
    const scheduler = new TaskScheduler({ tasks: () => tasks, capacity: () => 2, liveCount: () => tasks.filter(task => task.state === 'running').length, enabled: () => true, persist: () => store.save(tasks), prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async task => { launches.push(task.delegation!.childKey); task.state = 'running'; } });
    const host = {
      tasks: () => tasks,
      materialize: async () => { const records = await dispatches.materialize({ parentId, runId, repository: canonical, parentTitle: parent.title, decisions: [decision], configuredRoot: path.join(root, 'worktrees') }); const children = createDelegatedChildren(parent, [decision], records); for (const item of children) if (!tasks.some(task => task.id === item.id)) tasks.push(item); await store.save(tasks); return children; },
      enroll: async () => { const expected = createDelegatedChildren(parent, [decision], await dispatches.load(parentId, runId)); const children = tasks.filter(task => task.delegation?.runId === runId); enrollDelegatedChildren(parent, expected, children); await store.save(tasks); return children; },
      enqueue: async (task: Task) => scheduler.enqueue(task, { type: 'startManaged' })
    };
    await dispatchAcceptedAutoDelegation(parent, [decision], host);
    assert.deepEqual(launches.sort(), ['alpha', 'beta']);
    const children = () => tasks.filter(task => task.delegation?.runId === runId);
    assert.equal(new Set(children().map(task => task.worktree)).size, 3);
    assert.equal(children().find(task => task.delegation?.childKey === 'gamma')?.schedule?.state, 'queued');
    const beforeStop = deriveAutoDelegationStopRecoveryIntent({ parent, runId, tasks, reconciliation: projectDelegationReconciliation(parent, runId, tasks, await dispatches.load(parentId, runId)), ownership: children().map(task => ({ taskId: task.id, ownership: 'owned' as const })) });
    assert.equal(beforeStop.children.filter(item => item.action === 'stop-owned-writer').length, 2);
    await store.save(tasks);
    tasks = await store.load();
    await dispatchAcceptedAutoDelegation(tasks[0]!, [decision], host);
    assert.equal(launches.length, 2, 'restart never repeats a launch');
    const gamma = children().find(task => task.delegation?.childKey === 'gamma')!;
    assert.equal(gamma.schedule?.state, 'queued');

    // Provider completion is simulated with real, separate Git commits. No model turn is submitted.
    const records: ReturnType<typeof prepareDelegationResult>[] = [];
    for (const key of ['beta', 'alpha', 'gamma']) {
      if (key === 'gamma') {
        assert.equal(children().find(task => task.delegation?.childKey === key)?.schedule?.state, 'queued');
        await scheduler.drain();
        assert.ok(launches.includes(key), 'gamma launches after its reviewed prerequisite releases capacity');
      }
      const item = children().find(task => task.delegation?.childKey === key)!;
      await mkdir(path.join(item.worktree, 'src', key), { recursive: true });
      await writeFile(path.join(item.worktree, 'src', key, 'index.txt'), `${key}\n`);
      await git(item.worktree, ['add', '.']); await git(item.worktree, ['commit', '-m', `complete ${key}`]);
      const commit = (await git(item.worktree, ['rev-parse', 'HEAD'])).trim(), tree = (await git(item.worktree, ['rev-parse', 'HEAD^{tree}'])).trim();
      item.state = 'idle'; item.schedule!.state = 'finished';
      if (key === 'alpha') {
        assert.equal(item.reviewedCommit, undefined, 'alpha has completed but is not reviewed');
        assert.equal(tasks.filter(task => task.state === 'running').length, 0, 'both scheduler slots are available');
        assert.equal((await reviewJournal.load(parentId, runId)).length, 1, 'only beta has a durable parent review');
        await store.save(tasks);
        await scheduler.drain();
        assert.equal(gamma.schedule?.state, 'queued', 'gamma remains queued while alpha lacks a reviewed commit');
        assert.deepEqual(launches.sort(), ['alpha', 'beta'], 'capacity alone cannot launch gamma');
      }
      item.reviewedCommit = { commit, tree, baseCommit: base, reviewedAt: now };
      item.verificationEvidence = { version: 1, attempts: [{ id: 'e'.repeat(24), number: 1, checkedCommit: commit, checkedTree: tree, startedAt: now, finishedAt: now, findings: [], checks: [{ id: 'focused', required: true, status: 'passed', command: { executable: 'npm.cmd', args: ['test'] }, finishedAt: now, exitCode: 0, artifacts: [{ kind: 'log', path: `delegation-evidence/${key}/focused.log`, label: 'Focused test output' }] }] }] };
      const dependencies = key === 'gamma' ? [{ childKey: 'alpha', receiptSha256: records.find(record => record.childKey === 'alpha')!.sha256 }] : [];
      const binding = { parentId, runId, childKey: key, dispatchKey: item.delegation!.dispatchKey, baseCommit: base, writeScope: [`src/${key}/`], dependencies };
      const result = prepareDelegationResult({ version: 1, parentId, runId, childKey: key, dispatchKey: binding.dispatchKey, baseCommit: base, commit, tree, changedPaths: [`src/${key}/index.txt`], decisions: 'Kept the scoped change.', summary: `${key} complete.`, unresolved: [], validations: [], evidence: [], dependencies: binding.dependencies }, binding);
      const dispatch = (await dispatches.load(parentId, runId)).find(record => record.childKey === key)!;
      const { sha256: _expectedSha256, ...unsignedResult } = result;
      const saved = await ingress.receive(unsignedResult, { child: item, binding, dispatch });
      assert.equal(saved.sha256, result.sha256);
      records.push(saved);
      await reviewJournal.append({ version: 1, parentId, runId, childKey: key, resultSha256: saved.sha256, evidenceSha256: createHash('sha256').update(JSON.stringify(item.verificationEvidence)).digest('hex'), commit, tree, reviewer: 'parent-human', decision: 'approved', reviewedAt: now, reason: 'Reviewed the saved child diff and evidence.' }, { child: item, binding, result: saved });
      await store.save(tasks);
      if (key === 'alpha') {
        assert.equal(gamma.schedule?.state, 'queued', 'gamma waits for the drain after alpha review');
      }
    }
    const resultRecords = await resultJournal.loadResultRecords(parentId, runId);
    const reviews = await reviewJournal.load(parentId, runId);
    assert.equal(resultRecords.length, 3); assert.equal(reviews.length, 3);
    gamma.schedule!.state = 'blocked';
    assert.equal(prepareAutoDelegationParentWakeup(parent, runId, ['alpha', 'beta', 'gamma'], children(), resultRecords, reviews).status, 'blocked');
    gamma.schedule!.state = 'finished';
    assert.equal(prepareAutoDelegationParentWakeup(parent, runId, ['alpha', 'beta', 'gamma'], children(), resultRecords, reviews.slice(0, 2)).status, 'blocked');
    const wake = prepareAutoDelegationParentWakeup(parent, runId, ['alpha', 'beta', 'gamma'], children(), resultRecords, reviews);
    assert.equal(wake.status, 'ready');
    await store.save(tasks); tasks = await store.load();
    const reloadedRecords = await new DelegationOrchestrationJournal(path.join(root, 'results')).loadResultRecords(parentId, runId);
    const reloadedReviews = await new DelegationParentReviewJournal(path.join(root, 'reviews')).load(parentId, runId);
    assert.deepEqual(prepareAutoDelegationParentWakeup(tasks[0]!, runId, ['alpha', 'beta', 'gamma'], tasks.slice(1), reloadedRecords, reloadedReviews), wake);
    const projection = reloadedRecords.map(record => ({ source: { child: children().find(child => child.delegation?.childKey === record.binding.childKey)!, binding: record.binding, result: record.receipt }, receipts: reloadedReviews.filter(review => review.childKey === record.binding.childKey) }));
    const currentParent = tasks[0]!;
    await mkdir(path.join(currentParent.worktree, 'src'), { recursive: true });
    for (const key of ['alpha', 'beta', 'gamma']) { await mkdir(path.join(currentParent.worktree, 'src', key), { recursive: true }); await writeFile(path.join(currentParent.worktree, 'src', key, 'index.txt'), `${key}\n`); }
    await git(currentParent.worktree, ['add', '.']); await git(currentParent.worktree, ['commit', '-m', 'integrate reviewed children']);
    currentParent.reviewedCommit = { commit: (await git(currentParent.worktree, ['rev-parse', 'HEAD'])).trim(), tree: (await git(currentParent.worktree, ['rev-parse', 'HEAD^{tree}'])).trim(), baseCommit: base, reviewedAt: now };
    const integrations = new Integrations(path.join(root, 'integration'), () => {}, () => tasks, task => delegationIntegrationGate(task, tasks, { parentReviews: projection }));
    const targetBeforeFailure = (await git(canonical, ['rev-parse', 'HEAD'])).trim();
    const parentBeforeFailure = (await git(currentParent.worktree, ['rev-parse', 'HEAD'])).trim();
    const fail = await integrations.prepare(currentParent, [{ executable: process.execPath, args: ['-e', 'process.exit(7)'] }], () => {});
    assert.equal(fail.phase, 'failed');
    assert.equal((await git(canonical, ['rev-parse', 'HEAD'])).trim(), targetBeforeFailure);
    assert.equal((await git(currentParent.worktree, ['rev-parse', 'HEAD'])).trim(), parentBeforeFailure);
    assert.equal((await git(fail.candidate, ['rev-parse', 'HEAD'])).trim(), fail.candidateCommit);
    assert.equal((await integrations.store.load(tasks)).find(operation => operation.id === fail.id)?.phase, 'failed');
    await assert.rejects(integrations.promote(currentParent, fail, () => {}), /validated/);
    const check = { executable: process.execPath, args: ['-e', "const fs=require('node:fs');for(const k of ['alpha','beta','gamma'])if(fs.readFileSync('src/'+k+'/index.txt','utf8')!==k+'\\n')process.exit(2)"] };
    const accepted = await integrations.prepare(currentParent, [check], () => {});
    assert.equal(accepted.phase, 'validated');
    await integrations.promote(currentParent, accepted, () => {});
    assert.equal(accepted.phase, 'promoted');
    for (const key of ['alpha', 'beta', 'gamma']) assert.equal(await readFile(path.join(canonical, 'src', key, 'index.txt'), 'utf8'), `${key}\n`);
    assert.deepEqual(launches, ['alpha', 'beta', 'gamma']);
    // Exercise the supported queued Stop path; owned provider interruption requires a live session.
    const pending: Task = { id: '555555555555', title: 'Pending stop', prompt: 'Hold before launch', repository: canonical, ...parentWorktree, provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now, schedule: { state: 'queued', dependencies: [], artifacts: [], request: { type: 'startManaged' } } };
    tasks.push(pending);
    await store.save(tasks);
    await scheduler.cancel(pending);
    tasks = await store.load();
    assert.equal(tasks.find(task => task.id === pending.id)?.schedule?.state, 'cancelled');
    assert.equal(tasks.find(task => task.id === pending.id)?.schedule?.request, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
