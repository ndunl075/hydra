import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatchAcceptedAutoDelegation } from '../src/core/autoDelegationDispatch';
import { createDelegatedChildren, enrollDelegatedChildren } from '../src/core/delegationChildren';
import { DelegationDispatchStore } from '../src/core/delegationDispatch';
import { digest } from '../src/core/delegationContext';
import { prepareDelegation, type DelegationPolicy, type DelegationProposal } from '../src/core/delegationPlan';
import { DelegationStore } from '../src/core/delegationStore';
import { TaskScheduler } from '../src/core/scheduler';
import { LocalStore } from '../src/core/store';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', proposalId = '333333333333', base = 'a'.repeat(40);
const policy: DelegationPolicy = { parentId, runId, mode: 'auto', level: 0, maxChildren: 2, provider: 'codex', models: [], approvedBases: [base], writeScope: ['src/'], otherOwners: [], context: { userIntent: 'Build modules', qualityTarget: 'Pass checks', constraints: ['Keep scope'], instructions: [], interfaces: [], evidence: [], maxTurns: 1, timeoutMs: 300000 } };
const child = (key: string, dependencies: string[] = []) => ({ key, goal: `Build ${key}`, deliverable: `${key} module`, baseCommit: base, writeScope: [`src/${key}/`], dependencies, acceptance: [`Check ${key}`], testCommands: [], contextRefs: [], provider: 'codex' as const });
const proposal = (dependent = false): DelegationProposal => ({ version: 1, id: proposalId, parentId, runId, decision: 'delegate', rationale: 'Two separate modules', children: [child('alpha'), child('beta', dependent ? ['alpha'] : [])] });

async function fixture(dependent = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-auto-dispatch-'));
  const repository = path.join(directory, 'repo');
  const decisions = [prepareDelegation(proposal(dependent), policy)];
  const parent: Task = { id: parentId, title: 'Parent', prompt: 'Build modules', repository, worktree: path.join(directory, 'parent'), branch: 'agent/parent-111111111111', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', delegationPlanner: { version: 1, runId, state: 'accepted', policy, preferences: { mode: 'auto', maxChildren: 2, status: 'preparation' }, turnId: '444444444444', proposalId, sha256: digest(JSON.stringify(decisions[0]!.proposal)) } };
  const taskStore = new LocalStore(path.join(directory, 'tasks'));
  const created: string[] = [], launched: string[] = [];
  const dispatches = new DelegationDispatchStore(path.join(directory, 'dispatches'), async () => {}, async (_repo, title, id, _root, commit) => {
    created.push(id);
    return { worktree: path.join(directory, id), branch: `agent/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`, baseCommit: commit!, integrationTarget: 'main' };
  });
  let tasks = [parent];
  const scheduler = new TaskScheduler({ tasks: () => tasks, capacity: () => 2, liveCount: () => tasks.filter(task => task.state === 'running').length, enabled: () => true,
    persist: () => taskStore.save(tasks), prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async task => { launched.push(task.id); task.state = 'running'; } });
  const host = {
    tasks: () => tasks,
    materialize: async () => {
      const records = await dispatches.materialize({ parentId, runId, repository, parentTitle: parent.title, decisions });
      const children = createDelegatedChildren(parent, decisions, records);
      for (const child of children) if (!tasks.some(task => task.id === child.id)) tasks.push(child);
      await taskStore.save(tasks);
      return children;
    },
    enroll: async () => { const expected = createDelegatedChildren(parent, decisions, await dispatches.load(parentId, runId)); const children = tasks.filter(task => task.delegation?.runId === runId); enrollDelegatedChildren(parent, expected, children); await taskStore.save(tasks); return children; },
    enqueue: async (task: Task) => scheduler.enqueue(task, { type: 'startManaged' })
  };
  return { directory, parent, decisions, taskStore, created, launched, dispatches, scheduler, host, reload: async () => { tasks = await taskStore.load(); }, children: () => tasks.filter(task => task.delegation?.runId === runId) };
}

test('two independent accepted children materialize once and queue through shared capacity', async () => {
  const f = await fixture();
  try {
    await dispatchAcceptedAutoDelegation(f.parent, f.decisions, f.host);
    assert.equal(new Set(f.children().map(task => task.worktree)).size, 2);
    assert.equal(f.created.length, 2);
    assert.equal(f.launched.length, 2);
    await f.reload();
    await dispatchAcceptedAutoDelegation(f.host.tasks()[0]!, f.decisions, f.host);
    assert.equal(f.created.length, 2);
    assert.equal(f.launched.length, 2);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('a rewritten valid decision with the same ID and run cannot materialize or launch', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.directory, 'decisions');
    const store = new DelegationStore(directory, async () => {});
    await store.recordDecision(proposal(), policy);
    const file = path.join(directory, `delegation-${parentId}-${runId}.json`);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.decisions[0].input.children[0].goal = 'Build a different alpha module';
    saved.decisions[0].sha256 = digest(JSON.stringify({ input: saved.decisions[0].input, policy: saved.decisions[0].policy }));
    await writeFile(file, JSON.stringify(saved));
    const rewritten = await store.load(parentId, runId);
    await assert.rejects(dispatchAcceptedAutoDelegation(f.parent, rewritten.decisions, f.host), /planner receipt digest/);
    assert.equal(f.created.length, 0);
    assert.equal(f.launched.length, 0);
    assert.equal(f.children().length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('malformed accepted planner digests fail before any side effect', async () => {
  const f = await fixture();
  try {
    f.parent.delegationPlanner!.sha256 = 'b'.repeat(63);
    await assert.rejects(dispatchAcceptedAutoDelegation(f.parent, f.decisions, f.host), /planner receipt digest/);
    assert.equal(f.created.length, 0);
    assert.equal(f.launched.length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('dependent child retains a durable request while its prerequisite is unfinished', async () => {
  const f = await fixture(true);
  try {
    await dispatchAcceptedAutoDelegation(f.parent, f.decisions, f.host);
    assert.equal(f.launched.length, 1);
    const beta = f.children().find(task => task.delegation?.childKey === 'beta')!;
    assert.equal(beta.schedule?.state, 'queued');
    assert.equal(beta.schedule?.dependencies.length, 1);
    await f.reload();
    await dispatchAcceptedAutoDelegation(f.host.tasks()[0]!, f.decisions, f.host);
    assert.equal(f.launched.length, 1);
    assert.equal(f.created.length, 2);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('replay after materialization, enrollment, and a cancelled request does not duplicate or revive work', async () => {
  const f = await fixture();
  try {
    await f.host.materialize();
    await f.reload();
    await f.host.enroll();
    await f.reload();
    const first = f.children()[0]!;
    first.schedule!.state = 'cancelled';
    await f.taskStore.save(f.host.tasks());
    await f.reload();
    await dispatchAcceptedAutoDelegation(f.host.tasks()[0]!, f.decisions, f.host);
    assert.equal(f.created.length, 2);
    assert.equal(f.launched.length, 1);
    assert.equal(f.children().find(task => task.id === first.id)?.schedule?.state, 'cancelled');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('restart between child queue writes never requeues the first writer', async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    await assert.rejects(dispatchAcceptedAutoDelegation(f.parent, f.decisions, { ...f.host, enqueue: async task => {
      if (++attempts === 2) throw new Error('interrupted before second queue write');
      await f.host.enqueue(task);
    } }), /interrupted before second/);
    assert.equal(f.launched.length, 1);
    await f.reload();
    await dispatchAcceptedAutoDelegation(f.host.tasks()[0]!, f.decisions, f.host);
    assert.equal(f.launched.length, 2);
    assert.equal(new Set(f.launched).size, 2);
    assert.equal(f.created.length, 2);
    await f.reload();
    f.scheduler.reconcile();
    await f.taskStore.save(f.host.tasks());
    await dispatchAcceptedAutoDelegation(f.host.tasks()[0]!, f.decisions, f.host);
    assert.equal(f.launched.length, 2, 'uncertain interrupted writers are never restarted automatically');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
