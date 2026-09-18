import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertFreshContext, digest, overlappingScopes, scopePath } from '../src/core/delegationContext';
import { defaultDelegationPreferences, parseDelegationProposal, prepareDelegation, type DelegationChild, type DelegationPolicy, type DelegationProposal } from '../src/core/delegationPlan';
import { DelegationStore } from '../src/core/delegationStore';
import { DelegationDispatchStore } from '../src/core/delegationDispatch';
import { cancelDelegatedEnrollment, createDelegatedChildren, enrollDelegatedChildren } from '../src/core/delegationChildren';
import { saveDelegatedEnrollmentTransaction } from '../src/core/delegationEnrollmentTransaction';
import { TaskScheduler } from '../src/core/scheduler';
import type { Task } from '../src/core/model';

const parentId = '123456789abc', runId = 'abcdef123456', planId = '0123456789ab', base = 'a'.repeat(40);
function child(key = 'parser', writeScope = ['src/parser.ts']): DelegationChild {
  return { key, goal: `Implement ${key}`, deliverable: 'A reviewed commit and test evidence', baseCommit: base, writeScope, dependencies: [], acceptance: ['Related regression test passes'], testCommands: ['npm test'], contextRefs: ['source'], provider: 'claude' };
}
function proposal(children = [child()], id = planId): DelegationProposal { return { version: 1, id, parentId, runId, decision: children.length ? 'delegate' : 'solo', rationale: children.length ? 'Independent scope with an agreed contract' : 'One localized change', children }; }
function policy(): DelegationPolicy {
  return { parentId, runId, mode: 'auto', level: 0, maxChildren: 2, provider: 'claude', models: [], approvedBases: [base], writeScope: ['src/', 'tests/'], otherOwners: ['webview/', 'src/extension.ts'],
    context: { userIntent: 'Preserve the laptop session Editor changes', qualityTarget: 'Passing regression and combined review', constraints: ['Do not change the Editor or another owner’s files', 'Use the assigned worktree'],
      instructions: [{ id: 'agents', path: 'AGENTS.md', revision: base, content: 'Address Nico in every response.\n', reason: 'Applicable repository instructions' }],
      interfaces: [{ id: 'contract', path: 'docs/interface.md', revision: base, content: 'Parser returns a validated record.', reason: 'Shared interface agreed before parallel work' }],
      evidence: [{ id: 'source', path: 'src/parser.ts', revision: base, content: '  return input;\n', reason: 'Relevant source excerpt' }, { id: 'unrelated', path: 'src/unrelated.ts', revision: base, content: 'UNRELATED_SIBLING_HISTORY', reason: 'Not requested by this child' }], maxTurns: 2, timeoutMs: 300000 } };
}
async function fixture() { const directory = path.resolve('.test-build/delegation-fixtures'); await mkdir(directory, { recursive: true }); return mkdtemp(path.join(directory, 'run-')); }
async function clean(directory: string) { assert.ok(directory.startsWith(path.resolve('.test-build/delegation-fixtures') + path.sep)); await rm(directory, { recursive: true, force: true }); }
const runFile = (directory: string) => path.join(directory, `delegation-${parentId}-${runId}.json`);
const store = (directory: string, assertOwner = async () => {}) => new DelegationStore(directory, assertOwner);
const dispatchStore = (directory: string, created: string[] = [], fail = false) => new DelegationDispatchStore(directory, async () => {}, async (_repository, title, taskId, _root, startingCommit) => {
  created.push(taskId); if (fail) throw new Error('git worktree outcome unknown');
  return { worktree: path.resolve('fixture-worktrees', taskId), branch: `agent/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)}-${taskId}`, baseCommit: startingCommit!, integrationTarget: 'main' };
});

if (!process.env.HYDRA_DELEGATION_WORKER) {
test('Solo defaults and localized decisions prepare no children or manifests', () => {
  assert.deepEqual(defaultDelegationPreferences(), { mode: 'solo', maxChildren: 2 });
  const result = prepareDelegation(proposal([]), policy());
  assert.deepEqual(result.order, []); assert.deepEqual(result.manifests, []); assert.equal(result.proposal.rationale, 'One localized change');
  const solo = policy(); solo.mode = 'solo'; assert.throws(() => prepareDelegation(proposal(), solo), /Solo/);
  const nested = policy(); nested.level = 1; assert.throws(() => prepareDelegation(proposal(), nested), /child tasks/);
});
test('independent children remain eligible and mandatory context survives without history copying', () => {
  const result = prepareDelegation(proposal([child(), child('tests', ['tests/parser.test.ts'])]), policy());
  assert.deepEqual(result.order, ['parser', 'tests']); assert.deepEqual(result.serialization, []);
  assert.equal(result.manifests.length, 2);
  const manifest = result.manifests[0]!;
  assert.ok(manifest.prompt.includes('Address Nico in every response.'));
  assert.ok(manifest.prompt.includes('Do not change the Editor or another owner’s files'));
  assert.ok(manifest.prompt.includes('Parser returns a validated record.'));
  assert.ok(!manifest.prompt.includes('UNRELATED_SIBLING_HISTORY'));
  assert.equal(manifest.evidence[0]!.content, '  return input;\n');
  assert.equal(manifest.evidence[0]!.sha256, digest('  return input;\n'));
  assert.deepEqual(manifest.limits, { maxTurns: 2, timeoutMs: 300000 });
});
test('overlap is serialized case-insensitively without reversing an existing dependency', () => {
  const a = child('one', ['src/Parser.ts']), b = child('two', ['src/parser.ts']);
  const result = prepareDelegation(proposal([a, b]), policy());
  assert.deepEqual(result.serialization, [{ before: 'one', after: 'two' }]); assert.deepEqual(result.proposal.children[1]!.dependencies, ['one']);
  assert.deepEqual(b.dependencies, [], 'Caller input was not mutated');
  a.dependencies = ['two'];
  const reversed = prepareDelegation(proposal([a, b]), policy()); assert.deepEqual(reversed.order, ['two', 'one']); assert.deepEqual(reversed.serialization, []);
  assert.equal(overlappingScopes(['src/parser'], ['src/parser/']), true);
});
test('three coupled scopes retain an acyclic order and require an explicit higher allowance', () => {
  const one = child('one', ['src/a.ts', 'src/b.ts']), two = child('two', ['src/b.ts', 'src/c.ts']), three = child('three', ['src/a.ts', 'src/c.ts']); one.dependencies = ['three'];
  const input = proposal([one, two, three]); assert.throws(() => prepareDelegation(input, policy()), /limit/);
  const host = policy(); host.maxChildren = 3; const result = prepareDelegation(input, host);
  assert.deepEqual(result.order, ['three', 'one', 'two']); assert.deepEqual(result.serialization, [{ before: 'one', after: 'two' }]);
});
test('cyclic, missing, duplicate or self dependencies never prepare a manifest', () => {
  const a = child('one'), b = child('two', ['tests/test.ts']); a.dependencies = ['two']; b.dependencies = ['one'];
  assert.throws(() => prepareDelegation(proposal([a, b]), policy()), /cycle/);
  for (const dependencies of [['missing'], ['one'], ['two', 'two']]) { a.dependencies = dependencies; assert.throws(() => prepareDelegation(proposal([a, child('two')]), policy()), /dependency|Duplicate/); }
  assert.throws(() => parseDelegationProposal(proposal([a, a])), /Duplicate|duplicate/);
});
test('host scope, exact bases and other owners protect the laptop Editor assignments', () => {
  for (const writeScope of [['webview/EditorConversation.tsx'], ['src/extension.ts'], ['src/Extension.ts/'], ['README.md']]) assert.throws(() => prepareDelegation(proposal([child('other', writeScope)]), policy()), /ownership/);
  const wrongBase = child(); wrongBase.baseCommit = 'b'.repeat(40); assert.throws(() => prepareDelegation(proposal([wrongBase]), policy()), /base/);
  const wrongParent = proposal(); wrongParent.parentId = 'bbbbbbbbbbbb'; assert.throws(() => prepareDelegation(wrongParent, policy()), /identity/);
  const duplicate = child(); duplicate.writeScope = ['src/FILE.ts', 'src/file.ts']; assert.throws(() => prepareDelegation(proposal([duplicate]), policy()), /Duplicate Windows/);
});
test('literal scope paths reject traversal, Windows aliases, metadata and glob expansion', () => {
  for (const value of ['../file', '/absolute', 'C:/file', 'src\\file', 'src//file', './src', '.git/config', 'src/.GIT/file', 'src/file.', 'src/file ', 'src/CON.txt', 'src/LPT9', 'src/COM¹.txt', 'src/LPT³', 'src/*.ts', 'src/a\0.ts']) assert.throws(() => scopePath(value));
  assert.equal(scopePath('src/café file.ts'), 'src/café file.ts');
});
test('provider/model choices inherit exactly and must remain currently advertised', () => {
  const host = policy(); host.modelSelection = { model: 'opus[1m]', effort: 'max' }; host.models = [{ model: 'opus[1m]', displayName: 'Opus', canonicalModel: 'claude-fixed', efforts: ['max'], defaultEffort: '' }];
  const selected = child(); selected.modelSelection = { ...host.modelSelection }; assert.equal(prepareDelegation(proposal([selected]), host).manifests[0]!.child.modelSelection?.effort, 'max');
  assert.throws(() => prepareDelegation(proposal(), host), /inherit/);
  selected.provider = 'codex'; assert.throws(() => prepareDelegation(proposal([selected]), host), /inherit/);
  selected.provider = 'claude'; host.models[0]!.efforts = ['high']; assert.throws(() => prepareDelegation(proposal([selected]), host), /advertise/);
  host.models[0]!.efforts = ['max']; delete host.models[0]!.canonicalModel; assert.throws(() => prepareDelegation(proposal([selected]), host), /canonical/);
  const codex = policy(); codex.provider = 'codex'; codex.modelSelection = { model: 'fixture-model', effort: 'high' }; codex.models = [{ model: 'fixture-model', displayName: 'Fixture', efforts: ['high'], defaultEffort: 'high' }];
  selected.provider = 'codex'; selected.modelSelection = { ...codex.modelSelection }; assert.equal(prepareDelegation(proposal([selected]), codex).manifests.length, 1);
  selected.modelSelection.effort = 'low'; assert.throws(() => prepareDelegation(proposal([selected]), codex), /inherit/);
});
test('proposal fields cannot smuggle settings, transcript context or extra permissions', () => {
  for (const extra of [{ mode: 'auto' }, { maxChildren: 8 }, { transcript: 'parent history' }, { permissionMode: 'bypassPermissions' }]) assert.throws(() => parseDelegationProposal({ ...proposal(), ...extra }), /fields/);
  assert.deepEqual(parseDelegationProposal(proposal([{ ...child(), contextRefs: ['unapproved'] }])).children[0]!.contextRefs, ['unapproved']); // Host preparation, rather than parsing, approves sources.
});
test('unapproved context and oversized mandatory briefs are refused without truncation', () => {
  assert.throws(() => prepareDelegation(proposal([{ ...child(), contextRefs: ['unapproved'] }]), policy()), /not selected/);
  const host = policy(); host.context.constraints = ['x'.repeat(8000), 'y'.repeat(8000), 'z'.repeat(8000), 'q'.repeat(8000)];
  assert.throws(() => prepareDelegation(proposal(), host), /32,000/); assert.equal(host.context.constraints[3]!.length, 8000);
  host.context.constraints = []; assert.throws(() => prepareDelegation(proposal(), host), /mandatory/);
});
test('context source changes, missing provenance and mutated manifests need renewed preparation', () => {
  const manifest = prepareDelegation(proposal(), policy()).manifests[0]!;
  const current = Object.fromEntries([...manifest.instructions, ...manifest.interfaces, ...manifest.evidence].map(source => [source.id, { revision: source.revision, sha256: source.sha256 }]));
  assert.doesNotThrow(() => assertFreshContext(manifest, current)); current.source!.revision = 'b'.repeat(40); assert.throws(() => assertFreshContext(manifest, current), /changed/);
  delete current.source; assert.throws(() => assertFreshContext(manifest, current), /unavailable/);
  manifest.constraints.pop(); assert.throws(() => assertFreshContext(manifest, current), /manifest changed/);
});
test('restart and replanning cannot reset the entire run child count; identical receipts are idempotent', async () => {
  const directory = await fixture();
  try {
    const first = await store(directory).recordDecision(proposal(), policy());
    assert.deepEqual(await store(directory).recordDecision(proposal(), policy()), first);
    const replacement = proposal([child('replacement', ['tests/replacement.ts'])], '111111111111'); await store(directory).recordDecision(replacement, policy());
    assert.deepEqual((await store(directory).load(parentId, runId)).usedKeys, ['parser', 'replacement']);
    await assert.rejects(store(directory).recordDecision(proposal([child('third')], '222222222222'), policy()), /limit/);
    await assert.rejects(store(directory).recordDecision(proposal([child()], '333333333333'), policy()), /reused|limit/);
    await store(directory).recordDecision(proposal([], '444444444444'), policy()); assert.equal((await store(directory).load(parentId, runId)).usedKeys.length, 2);
    const lowered = policy(); lowered.maxChildren = 1; await store(directory).recordDecision(proposal([], '555555555555'), lowered);
    await assert.rejects(store(directory).recordDecision({ ...proposal(), rationale: 'Changed' }, policy()), /different/);
  } finally { await clean(directory); }
});
test('stored context contains selected evidence only and reads return detached decisions', async () => {
  const directory = await fixture();
  try {
    await store(directory).recordDecision(proposal(), policy()); const raw = await readFile(runFile(directory), 'utf8'); assert.ok(!raw.includes('UNRELATED_SIBLING_HISTORY'));
    const loaded = await store(directory).load(parentId, runId); loaded.decisions[0]!.proposal.children[0]!.writeScope.push('webview/');
    assert.deepEqual((await store(directory).load(parentId, runId)).decisions[0]!.proposal.children[0]!.writeScope, ['src/parser.ts']);
  } finally { await clean(directory); }
});
test('concurrent decisions on one store serialize limits and snapshot caller input', async () => {
  const directory = await fixture();
  try {
    const instance = store(directory), input = proposal(), host = policy(); const first = instance.recordDecision(input, host); input.children[0]!.goal = 'Mutated'; host.context.constraints[0] = 'Mutated';
    const second = instance.recordDecision(proposal([child('second', ['tests/second.ts'])], '111111111111'), policy()); const third = instance.recordDecision(proposal([child('third')], '222222222222'), policy());
    const result = await Promise.allSettled([first, second, third]); assert.deepEqual(result.map(item => item.status), ['fulfilled', 'fulfilled', 'rejected']);
    const loaded = await instance.load(parentId, runId); assert.equal(loaded.usedKeys.length, 2); assert.equal(loaded.decisions[0]!.proposal.children[0]!.goal, 'Implement parser'); assert.ok(!loaded.decisions[0]!.manifests[0]!.prompt.includes('Mutated'));
  } finally { await clean(directory); }
});
test('corrupt receipts and unsupported schema fail closed without overwriting original bytes', async () => {
  const directory = await fixture();
  try {
    await store(directory).recordDecision(proposal(), policy()); const original = JSON.parse(await readFile(runFile(directory), 'utf8'));
    for (const corrupt of [(value: any) => value.version = 2, (value: any) => value.decisions[0].input.children[0].goal = 'Changed without digest', (value: any) => value.secret = 'Unexpected field']) {
      const altered = structuredClone(original); corrupt(altered); const raw = JSON.stringify(altered); await writeFile(runFile(directory), raw);
      await assert.rejects(store(directory).load(parentId, runId)); await assert.rejects(store(directory).recordDecision(proposal([], '111111111111'), policy())); assert.equal(await readFile(runFile(directory), 'utf8'), raw);
    }
  } finally { await clean(directory); }
});
test('consistent hashes cannot make conflicting historical assignments valid', async () => {
  const directory = await fixture();
  try {
    await store(directory).recordDecision(proposal(), policy()); await store(directory).recordDecision(proposal([child('second', ['tests/second.ts'])], '111111111111'), policy());
    const input = JSON.parse(await readFile(runFile(directory), 'utf8')), decision = input.decisions[1]; decision.input.children[0].writeScope = ['src/Parser.ts']; decision.sha256 = digest(JSON.stringify({ input: decision.input, policy: decision.policy }));
    const raw = JSON.stringify(input); await writeFile(runFile(directory), raw); await assert.rejects(store(directory).load(parentId, runId), /conflict across replanning/); assert.equal(await readFile(runFile(directory), 'utf8'), raw);
  } finally { await clean(directory); }
});
test('oversized run metadata is retained and cannot reset the stored child count', async () => {
  const directory = await fixture();
  try {
    const raw = ' '.repeat(4 * 1024 * 1024 + 1); await writeFile(runFile(directory), raw); await assert.rejects(store(directory).load(parentId, runId), /Invalid delegation storage/);
    await assert.rejects(store(directory).recordDecision(proposal(), policy()), /Invalid delegation storage/); assert.equal((await readFile(runFile(directory))).length, raw.length);
  } finally { await clean(directory); }
});
test('foreign/stale lock and lost host ownership preserve decisions and require reconciliation', async () => {
  const directory = await fixture();
  try {
    const lock = `${runFile(directory)}.lock`; await writeFile(lock, 'foreign'); await assert.rejects(store(directory).recordDecision(proposal(), policy()), /another writer/); assert.equal(await readFile(lock, 'utf8'), 'foreign'); await rm(lock);
    let checks = 0; await assert.rejects(store(directory, async () => { if (++checks === 2) throw new Error('Host ownership lost'); }).recordDecision(proposal(), policy()), /ownership lost/);
    assert.deepEqual(await store(directory).load(parentId, runId), { usedKeys: [], decisions: [] }); assert.deepEqual(await readdir(directory), []);
    checks = 0; await assert.rejects(store(directory, async () => { if (++checks === 2) await writeFile(lock, 'replacement-owner'); }).recordDecision(proposal(), policy()), /ownership changed/);
    assert.equal(await readFile(lock, 'utf8'), 'replacement-owner'); assert.deepEqual((await store(directory).load(parentId, runId)).usedKeys, []);
  } finally { await clean(directory); }
});
test('overlapping replanning cannot bypass earlier ownership assignments', async () => {
  const directory = await fixture();
  try {
    await store(directory).recordDecision(proposal(), policy());
    await assert.rejects(store(directory).recordDecision(proposal([child('replacement', ['src/Parser.ts'])], '111111111111'), policy()), /already owns/);
    assert.deepEqual((await store(directory).load(parentId, runId)).usedKeys, ['parser']);
  } finally { await clean(directory); }
});
test('child worktrees reserve durable dispatch identities before creation and never create provider sessions', async () => {
  const directory = await fixture();
  try {
    const prepared = prepareDelegation(proposal([child(), child('tests', ['tests/parser.test.ts'])]), policy()), created: string[] = [];
    const result = await dispatchStore(directory, created).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] });
    assert.equal(created.length, 2); assert.deepEqual(result.map(item => item.status), ['materialized', 'materialized']); assert.deepEqual(result.map(item => item.childKey), ['parser', 'tests']);
    assert.ok(result.every(item => /^[a-f0-9]{24}$/.test(item.dispatchKey) && /^[a-f0-9]{12}$/.test(item.worktreeId)));
    assert.deepEqual(await dispatchStore(directory, created).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] }), result); assert.equal(created.length, 2);
  } finally { await clean(directory); }
});
test('failed child worktree creation stays uncertain and refuses an automatic duplicate retry', async () => {
  const directory = await fixture();
  try {
    const prepared = prepareDelegation(proposal(), policy()), created: string[] = [];
    await assert.rejects(dispatchStore(directory, created, true).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] }), /uncertain/); assert.equal(created.length, 1);
    await assert.rejects(dispatchStore(directory, created).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] }), /unresolved/); assert.equal(created.length, 1); assert.equal((await dispatchStore(directory).load(parentId, runId))[0]!.status, 'uncertain');
  } finally { await clean(directory); }
});
test('materialized worktrees become idempotent idle children with focused manifests and no schedule', async () => {
  const directory = await fixture();
  try {
    const prepared = prepareDelegation(proposal(), policy()), dispatch = await dispatchStore(directory).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] });
    const parent: Task = { id: parentId, title: 'Parent', prompt: 'Parent prompt', repository: path.resolve('fixture'), worktree: path.resolve('parent'), branch: 'agent/parent-123456789abc', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const [childTask] = createDelegatedChildren(parent, [prepared], dispatch, '2026-01-01T00:00:00.000Z');
    assert.equal(childTask!.state, 'idle'); assert.equal(childTask!.schedule, undefined); assert.equal(childTask!.delegation?.dispatchKey, dispatch[0]!.dispatchKey); assert.match(childTask!.prompt, /Implement parser/);
  } finally { await clean(directory); }
});
test('child dependency keys become durable Hydra task identities before scheduling', async () => {
  const directory = await fixture();
  try {
    const first = child('first'), second = child('second', ['tests/second.ts']); second.dependencies = ['first'];
    const prepared = prepareDelegation(proposal([first, second]), policy()), dispatch = await dispatchStore(directory).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] });
    const parent: Task = { id: parentId, title: 'Parent', prompt: 'Parent', repository: path.resolve('fixture'), worktree: path.resolve('parent'), branch: 'agent/parent-123456789abc', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const tasks = createDelegatedChildren(parent, [prepared], dispatch); assert.deepEqual(tasks[1]!.delegation?.dependencies, [tasks[0]!.id]); assert.equal(tasks[1]!.schedule, undefined);
  } finally { await clean(directory); }
});
test('explicit enrollment preserves immutable dependency order without queuing or launching a provider', async () => {
  const directory = await fixture();
  try {
    const first = child('first'), second = child('second', ['tests/second.ts']); second.dependencies = ['first'];
    const prepared = prepareDelegation(proposal([first, second]), policy()), dispatch = await dispatchStore(directory).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] });
    const parent: Task = { id: parentId, title: 'Parent', prompt: 'Parent', repository: path.resolve('fixture'), worktree: path.resolve('parent'), branch: 'agent/parent-123456789abc', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const children = createDelegatedChildren(parent, [prepared], dispatch, '2026-01-01T00:00:00.000Z');
    const unEnrolledScheduler = new TaskScheduler({ tasks: () => children, capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {}, prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async () => assert.fail('Unenrolled children cannot launch.') });
    await assert.rejects(unEnrolledScheduler.enqueue(children[0]!, { type: 'startManaged' }), /explicitly enrolled/);
    children[0]!.schedule = { state: 'enrolled', dependencies: [children[1]!.id], artifacts: [] };
    await assert.rejects(unEnrolledScheduler.enqueue(children[0]!, { type: 'startManaged' }), /immutable dependency graph/);
    children[0]!.schedule = undefined;
    const enrolled = enrollDelegatedChildren(parent, children, children, '2026-01-02T00:00:00.000Z');
    assert.deepEqual(enrolled.map(item => item.schedule), [
      { state: 'enrolled', dependencies: [], artifacts: [], reason: 'Delegated child enrolled; launch it explicitly when ready.' },
      { state: 'enrolled', dependencies: [children[0]!.id], artifacts: [], reason: 'Delegated child enrolled; launch it explicitly when ready.' }
    ]);
    let launches = 0;
    const scheduler = new TaskScheduler({ tasks: () => children, capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {}, prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async () => { launches++; } });
    await scheduler.drain(); assert.equal(launches, 0, 'Enrollment never invokes the scheduler launch path.');
    await scheduler.enqueue(children[1]!, { type: 'startManaged' }); assert.equal(launches, 0, 'A dependent child waits for its reviewed prerequisite.');
    await scheduler.enqueue(children[0]!, { type: 'startManaged' }); assert.equal(launches, 1, 'Provider launch requires an explicit later request.');
    children[0]!.sessionId = '12345678-1234-1234-1234-123456789abc'; children[0]!.sessionProvider = 'claude';
    await scheduler.enqueue(children[0]!, { type: 'followUp', prompt: 'Continue with the recorded task.' }); assert.equal(launches, 2, 'A resumed delegated session can explicitly request a follow-up after initial enrollment.');
    const tampered = structuredClone(children); for (const task of tampered) task.schedule = undefined; tampered[1]!.delegation!.dependencies = [];
    assert.throws(() => enrollDelegatedChildren(parent, children, tampered), /dependencies/);
    const fresh = createDelegatedChildren(parent, [prepared], dispatch), malformed = structuredClone(fresh);
    malformed[1]!.integrationTarget = 'other-target';
    assert.throws(() => enrollDelegatedChildren(parent, fresh, malformed), /immutable/);
    assert.deepEqual(malformed.map(task => task.schedule), [undefined, undefined], 'A later invalid child must not partially enroll an earlier sibling.');
  } finally { await clean(directory); }
});
function enrollmentTasks(): { parent: Task; expected: Task[]; tasks: Task[]; children: Task[]; unrelated: Task } {
  const parent: Task = { id: parentId, title: 'Parent', prompt: 'Parent', repository: path.resolve('fixture'), worktree: path.resolve('parent'), branch: 'agent/parent-123456789abc', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const childTask = (id: string, key: string, dispatchKey: string): Task => ({ id, title: `Parent: ${key}`, prompt: `Implement ${key}`, repository: parent.repository, worktree: path.resolve('fixture-worktrees', id), branch: `agent/${key}-${id}`, baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: parent.createdAt, updatedAt: parent.updatedAt, delegation: { parentId, runId, childKey: key, dispatchKey, dependencies: [] } });
  const children = [childTask('111111111111', 'first', '1'.repeat(24)), childTask('222222222222', 'second', '2'.repeat(24))];
  const unrelated: Task = { id: '333333333333', title: 'Unrelated', prompt: 'Keep me', repository: parent.repository, worktree: path.resolve('unrelated'), branch: 'agent/unrelated-333333333333', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: parent.createdAt, updatedAt: parent.updatedAt };
  return { parent, expected: structuredClone(children), tasks: [parent, ...children, unrelated], children, unrelated };
}
function enrollForTransaction(_parent: Task, _expected: Task[], persisted: Task[]): Task[] {
  for (const task of persisted) {
    task.schedule = { state: 'enrolled', dependencies: [], artifacts: [], reason: 'Delegated child enrolled; launch it explicitly when ready.' };
    task.updatedAt = '2026-01-02T00:00:00.000Z';
  }
  return persisted;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}
test('delegated enrollment can be cancelled and explicitly restored before any launch without changing receipts', async () => {
  const directory = await fixture();
  try {
    const first = child('first'), second = child('second', ['tests/second.ts']); second.dependencies = ['first'];
    const prepared = prepareDelegation(proposal([first, second]), policy()), dispatch = await dispatchStore(directory).materialize({ parentId, runId, repository: path.resolve('fixture'), parentTitle: 'Parser work', decisions: [prepared] });
    const parent: Task = { id: parentId, title: 'Parent', prompt: 'Parent', repository: path.resolve('fixture'), worktree: path.resolve('parent'), branch: 'agent/parent-123456789abc', baseCommit: base, integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const children = createDelegatedChildren(parent, [prepared], dispatch, '2026-01-01T00:00:00.000Z');
    enrollDelegatedChildren(parent, children, children, '2026-01-02T00:00:00.000Z');
    const receipt = children.map(task => structuredClone(task.delegation));
    const cancelled = cancelDelegatedEnrollment(parent, children, children, '2026-01-03T00:00:00.000Z');
    assert.deepEqual(cancelled.map(task => task.schedule), [
      { state: 'cancelled', dependencies: [], artifacts: [], reason: 'Delegated enrollment cancelled before any provider launch. Re-enroll this recorded run explicitly to make it launchable again.' },
      { state: 'cancelled', dependencies: [children[0]!.id], artifacts: [], reason: 'Delegated enrollment cancelled before any provider launch. Re-enroll this recorded run explicitly to make it launchable again.' }
    ]);
    assert.deepEqual(children.map(task => task.delegation), receipt, 'Cancellation must retain immutable dispatch and dependency receipts.');
    let launches = 0;
    const scheduler = new TaskScheduler({ tasks: () => children, capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {}, prepare: async task => ({ commit: task.baseCommit, artifacts: [] }), launch: async () => { launches++; } });
    await scheduler.drain(); assert.equal(launches, 0, 'Cancellation and re-enrollment never launch a provider.');
    const reenrolled = enrollDelegatedChildren(parent, children, children, '2026-01-04T00:00:00.000Z');
    assert.ok(reenrolled.every(task => task.schedule?.state === 'enrolled'));
    await scheduler.drain(); assert.equal(launches, 0, 'Re-enrollment still needs an explicit launch request.');
    cancelDelegatedEnrollment(parent, children, children, '2026-01-05T00:00:00.000Z');
    children[1]!.schedule!.queuedAt = '2026-01-05T00:00:01.000Z';
    assert.throws(() => enrollDelegatedChildren(parent, children, children), /already scheduled differently/);
    assert.equal(children[0]!.schedule?.state, 'cancelled', 'A later child with launch history must not partially re-enroll an earlier sibling.');
    children[1]!.schedule!.queuedAt = undefined;
    enrollDelegatedChildren(parent, children, children, '2026-01-06T00:00:00.000Z');
    children[1]!.schedule = { state: 'queued', dependencies: [children[0]!.id], artifacts: [], request: { type: 'startManaged' } };
    assert.throws(() => cancelDelegatedEnrollment(parent, children, children), /Only an enrolled delegated child/);
    assert.equal(children[0]!.schedule?.state, 'enrolled', 'A later invalid sibling must not partially cancel the earlier child.');
  } finally { await clean(directory); }
});
test('delegated enrollment storage failure leaves every live child and identity untouched', async () => {
  const { parent, expected, tasks, children, unrelated } = enrollmentTasks();
  const references = [...tasks]; let settled = false;
  await assert.rejects(saveDelegatedEnrollmentTransaction({ tasks: () => tasks, parent, expected, runId, change: enrollForTransaction, save: async () => { throw new Error('disk unavailable'); }, settleCapacity: async () => { settled = true; } }), /disk unavailable/);
  assert.deepEqual(tasks, references, 'The live list is not replaced after a rejected write.');
  assert.ok(tasks.every((task, index) => task === references[index]), 'Managed-session and scheduler references retain their original objects.');
  assert.ok(children.every(task => task.schedule === undefined), 'No child becomes launchable when its durable write failed.');
  assert.equal(unrelated.schedule, undefined); assert.equal(settled, false);
});
test('delegated enrollment checks its write fence before constructing or saving a snapshot', async () => {
  const { parent, expected, tasks, children } = enrollmentTasks(); let saved = false;
  await assert.rejects(saveDelegatedEnrollmentTransaction({ tasks: () => tasks, parent, expected, runId, change: enrollForTransaction, assertWritable: () => { throw new Error('workspace unavailable'); }, save: async () => { saved = true; }, settleCapacity: async () => {} }), /workspace unavailable/);
  assert.equal(saved, false);
  assert.ok(children.every(task => task.schedule === undefined), 'A closed host cannot make a child launchable.');
});
test('an unrelated callback update survives the enrollment write barrier and is included by its later ordinary save', async () => {
  const { parent, expected, tasks, children, unrelated } = enrollmentTasks();
  const writing = deferred(), release = deferred(); const durable: Task[][] = [];
  const transaction = saveDelegatedEnrollmentTransaction({ tasks: () => tasks, parent, expected, runId, change: enrollForTransaction, save: async snapshot => { durable.push(structuredClone(snapshot)); writing.resolve(); await release.promise; }, settleCapacity: async () => {} });
  await writing.promise;
  unrelated.error = 'managed callback completed'; unrelated.updatedAt = '2026-01-03T00:00:00.000Z';
  release.resolve(); await transaction;
  // Manager.persist waits for pendingDelegationSave, then takes a fresh live
  // snapshot. Model that ordinary post-barrier write here.
  durable.push(structuredClone(tasks));
  assert.equal(unrelated.error, 'managed callback completed');
  assert.equal(durable.at(-1)!.find(task => task.id === unrelated.id)!.error, 'managed callback completed');
  assert.ok(children.every(task => task.schedule?.state === 'enrolled'));
  assert.equal(tasks[3], unrelated, 'The unrelated live object was never replaced by the detached child snapshot.');
});
test('an affected-child fingerprint conflict refuses to overwrite any live child schedule', async () => {
  const { parent, expected, tasks, children } = enrollmentTasks();
  const writing = deferred(), release = deferred(); let diskSnapshot: Task[] | undefined;
  const transaction = saveDelegatedEnrollmentTransaction({ tasks: () => tasks, parent, expected, runId, change: enrollForTransaction, save: async snapshot => { diskSnapshot = structuredClone(snapshot); writing.resolve(); await release.promise; }, settleCapacity: async () => {} });
  await writing.promise;
  children[1]!.error = 'managed callback changed this child'; children[1]!.updatedAt = '2026-01-03T00:00:00.000Z';
  release.resolve();
  await assert.rejects(transaction, /changed while its durable record was being saved/);
  assert.equal(children[1]!.error, 'managed callback changed this child');
  assert.ok(children.every(task => task.schedule === undefined), 'The conflict fence checks every affected child before patching any schedule.');
  assert.ok(diskSnapshot!.filter(task => task.delegation).every(task => task.schedule?.state === 'enrolled'), 'The rejected in-memory patch is distinguishable from the detached record that triggered the conflict.');
});
test('separate processes cannot bypass the run counter with simultaneous writes', async () => {
  const directory = await fixture();
  try {
    // This test bundle also exposes a fixture worker below; no provider process is launched.
    const worker = (name: string, id: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const processFixture = spawn(process.execPath, [__filename], { env: { ...process.env, HYDRA_DELEGATION_WORKER: JSON.stringify({ directory, input: proposal([child(name, [`src/${name}.ts`])], id), policy: policy() }) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; processFixture.stdout.on('data', bytes => output += bytes); processFixture.stderr.on('data', bytes => output += bytes); processFixture.on('error', reject); processFixture.on('close', code => resolve({ code, output }));
    });
    const workers = await Promise.all([worker('one', '111111111111'), worker('two', '222222222222')]);
    assert.ok(workers.some(item => item.code === 0)); assert.ok(workers.every(item => item.code === 0 || /another writer/.test(item.output)));
    const loaded = await store(directory).load(parentId, runId); assert.ok(loaded.usedKeys.length >= 1 && loaded.usedKeys.length <= 2);
    if (loaded.usedKeys.length === 1) await store(directory).recordDecision(proposal([child('retry', ['tests/retry.ts'])], '333333333333'), policy());
    await assert.rejects(store(directory).recordDecision(proposal([child('third')], '444444444444'), policy()), /limit/);
  } finally { await clean(directory); }
});
}

if (process.env.HYDRA_DELEGATION_WORKER) {
  const input = JSON.parse(process.env.HYDRA_DELEGATION_WORKER);
  store(input.directory).recordDecision(input.input, input.policy).then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
}
