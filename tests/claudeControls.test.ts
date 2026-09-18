import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { readClaudeModels, readClaudeEffective, requireClaudeSelection, ClaudeMessages } from '../src/core/claudeControls';
import { discoverClaudeModels } from '../src/core/claudeModels';
import { ManagedClaude } from '../src/core/managedClaude';
import { SessionStore } from '../src/core/sessionStore';
import { LocalStore } from '../src/core/store';
import type { Task } from '../src/core/model';

const metadata = [{ value: 'opus[1m]', resolvedModel: 'claude-fixture-model', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['high', 'max'] }];
const selected = { model: 'opus[1m]', effort: 'max' };
import { terminateProcessTree } from '../src/core/process';

test('Claude awaits the asynchronous final slot guard and Stop during that guard cannot submit a prompt', async () => {
  const f = await fixture(); let calls = 0, entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const guard = new Promise<void>(resolve => { resume = resolve; });
  try {
    await f.manager.start(f.task, f.executable, 'must not submit', async () => { if (++calls === 2) { entered(); await guard; } });
    await waiting; await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
    await f.manager.stop(f.task.id); resume(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.manager.count, 0); await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
  } finally { resume(); await f.close(); }
});

test('Claude cleanup failure is durable, blocks resume, and is cleared only by explicit managed reconciliation', async () => {
  const f = await fixture({ delaySettings: true }); const errors: unknown[] = [];
  const manager = new ManagedClaude(f.store, () => f.taskStore.save([f.task]), () => {}, error => errors.push(error), async pid => { await terminateProcessTree(pid); throw Error('Simulated uncertain child cleanup after safely stopping the fixture tree'); });
  try {
    await manager.start(f.task, f.executable, 'must not submit');
    await waitFor(async () => { try { return (await readFile(path.join(f.root, 'claude-controls.jsonl'), 'utf8')).includes('get_settings'); } catch { return false; } });
    await manager.stop(f.task.id); assert.equal(manager.view(f.task.id)?.writerUncertain, true);
    assert.equal((await f.store.load(f.task.id)).writerUncertain, true); assert.equal(errors.length, 1);
    await assert.rejects(manager.start(f.task, f.executable, 'resume'), /reconcile/);
    const { ManagedSessions } = await import('../src/core/managedSessions');
    const owners = new ManagedSessions(f.store, async () => {}, () => {}, error => errors.push(error)); await owners.load(f.task);
    await owners.reconcile(f.task.id); assert.equal(owners.view(f.task.id)?.writerUncertain, undefined); assert.equal((await f.store.load(f.task.id)).writerUncertain, undefined);
    await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
  } finally { await manager.shutdown(); await f.close(); }
});
test('Claude models require explicit support, canonical identity and actual effective effort', () => {
  const models = readClaudeModels(metadata);
  assert.equal(models[0]?.defaultEffort, '');
  assert.deepEqual(readClaudeEffective({ applied: { model: 'claude-fixture-model', effort: 'max' } }, models, selected), { model: 'claude-fixture-model', effort: 'max' });
  for (const applied of [{ model: 'claude-fixture-model', effort: 'high' }, { model: 'other', effort: 'max' }, { model: 'claude-fixture-model' }, { model: 'claude-fixture-model', effort: null }]) assert.throws(() => readClaudeEffective({ applied }, models, selected), /No turn submitted/);
  assert.deepEqual(readClaudeEffective({ applied: { model: 'claude-fixture-model', effort: null } }, models), { model: 'claude-fixture-model', effort: null });
  assert.throws(() => requireClaudeSelection(models, { model: 'opus[1m]', effort: 'low' }));
  assert.throws(() => requireClaudeSelection(readClaudeModels([{ ...metadata[0], resolvedModel: undefined }]), selected));
  assert.deepEqual(readClaudeModels([{ value: 'haiku', displayName: 'Haiku', supportedEffortLevels: ['high'] }])[0]?.efforts, []);
  for (const value of [[metadata[0], metadata[0]], [{ ...metadata[0], supportedEffortLevels: ['highest'] }], [{ ...metadata[0], value: '--dangerous' }], [{ ...metadata[0], resolvedModel: '../x x' }]]) assert.throws(() => readClaudeModels(value));
});
test('Claude control framing validates envelopes, split UTF-8 and line limits', () => {
  const events: unknown[] = [], parser = new ClaudeMessages(value => events.push(value));
  const data = Buffer.from(JSON.stringify({ type: 'system', text: 'ü' }) + '\n');
  for (const byte of data) parser.push(Buffer.from([byte])); parser.end();
  assert.equal((events[0] as any).text, 'ü');
  for (const value of ['[]\n', 'null\n', '{}\n', 'not-json\n']) assert.throws(() => new ClaudeMessages(() => {}).push(Buffer.from(value)));
  assert.throws(() => new ClaudeMessages(() => {}).push(Buffer.alloc(1024 * 1024 + 1, 120)), /exceeded/);
});
async function fixture(scenario: unknown = {}) {
  const base = path.resolve('.test-build/claude-controls'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'spaces ü-')), script = path.join(root, 'cli.cjs');
  await writeFile(script, await readFile(path.resolve('tests/fixtures/claude-cli.cjs')));
  await writeFile(path.join(root, 'claude-scenario.json'), JSON.stringify(scenario));
  const executable = path.join(root, process.platform === 'win32' ? 'cli.cmd' : 'cli');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const task: Task = { id: '333333333333', title: 'Claude controls', prompt: 'fixture', repository: root, worktree: root, branch: 'agent/controls', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'claude', providerVersion: '2.1.270', interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelSelection: selected };
  const store = new SessionStore(path.join(root, 'sessions')), taskStore = new LocalStore(path.join(root, 'tasks'));
  const manager = new ManagedClaude(store, () => taskStore.save([task]), () => {}, error => { throw error; });
  return { root, executable, task, store, taskStore, manager, close: async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test('Claude discovery makes only metadata controls, strips account and creates no model turn', async () => {
  const f = await fixture();
  try {
    const models = await discoverClaudeModels(f.executable, f.root);
    assert.ok(models.some(model => model.model === selected.model));
    const controls = (await readFile(path.join(f.root, 'claude-controls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(controls.map(value => value.request.subtype), ['initialize', 'get_binary_version']);
    assert.ok(controls.every(value => value.args.includes('--safe-mode') && value.args.includes('--no-session-persistence')));
    assert.ok(!JSON.stringify(models).includes('PRIVATE_ACCOUNT_MARKER'));
    await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('Claude selected model/effort is acknowledged durably before first and resumed user frames', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.task, f.executable, 'first literal "$(keep)" ü'); await f.manager.finished(f.task.id);
    assert.equal(f.task.state, 'idle');
    await f.manager.start(f.task, f.executable, 'resumed fixture'); await f.manager.finished(f.task.id);
    const requests = (await readFile(path.join(f.root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 2); assert.equal(requests[0].prompt, 'first literal "$(keep)" ü');
    assert.equal(requests[1].args[requests[1].args.indexOf('--resume') + 1], f.task.sessionId);
    for (const turn of f.manager.view(f.task.id)!.turns) {
      assert.deepEqual(turn.modelSettings, { requested: selected, effective: { model: 'claude-fixture-model', effort: 'max' } });
      const raw = await readFile(f.store.rawPath(f.task.id, turn.id), 'utf8');
      assert.ok(!raw.includes('PRIVATE_ACCOUNT_MARKER') && !raw.includes('PRIVATE_SETTINGS_MARKER'));
      const entries = raw.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(entries.findIndex(entry => entry.type === 'effective-settings') < entries.findIndex(entry => entry.type === 'stdin' && entry.data.type === 'user'));
    }
    assert.deepEqual((await f.taskStore.load())[0]?.modelSelection, selected);
    assert.equal((await f.store.load(f.task.id)).turns.length, 2);
  } finally { await f.close(); }
});
test('Claude overrides, missing effective settings, unsafe modes and mismatched contracts prevent user frames', async () => {
  for (const scenario of [{ applied: { model: 'claude-fixture-model', effort: 'high' } }, { applied: { model: 'other', effort: 'max' } }, { applied: { model: 'claude-fixture-model' } }, { permissionMode: 'bypassPermissions' }, { version: '2.1.269' }, { badCorrelation: true }, { models: [] }]) {
    const f = await fixture(scenario);
    try {
      await f.manager.start(f.task, f.executable, 'must not submit'); await f.manager.finished(f.task.id);
      assert.equal(f.task.state, 'error'); assert.equal(f.manager.count, 0);
      await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
    } finally { await f.close(); }
  }
});
test('Claude resume refuses a saved alias whose canonical model changed since acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.task, f.executable, 'first fixture'); await f.manager.finished(f.task.id);
    await writeFile(path.join(f.root, 'claude-scenario.json'), JSON.stringify({ models: [{ ...metadata[0], resolvedModel: 'different-model' }], applied: { model: 'different-model', effort: 'max' } }));
    await f.manager.start(f.task, f.executable, 'must not submit'); await f.manager.finished(f.task.id);
    assert.equal(f.task.state, 'error'); assert.match(f.manager.view(f.task.id)!.turns.at(-1)!.error!, /canonical identity/);
    const requests = (await readFile(path.join(f.root, 'requests.jsonl'), 'utf8')).trim().split('\n'); assert.equal(requests.length, 1);
  } finally { await f.close(); }
});
test('Claude stop during handshake closes owned process without a model turn', async () => {
  const f = await fixture({ delaySettings: true });
  try {
    await f.manager.start(f.task, f.executable, 'must not submit');
    await waitFor(async () => { try { return (await readFile(path.join(f.root, 'claude-controls.jsonl'), 'utf8')).includes('get_settings'); } catch { return false; } });
    await f.manager.stop(f.task.id); assert.equal(f.task.state, 'interrupted'); assert.equal(f.manager.count, 0);
    await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('Claude post-acknowledgement launch guard prevents a prompt after durable settings', async () => {
  const f = await fixture(); let checks = 0;
  try {
    await f.manager.start(f.task, f.executable, 'must not submit', () => { if (++checks === 2) throw new Error('Launch intent cancelled after handshake'); });
    await f.manager.finished(f.task.id);
    assert.equal(checks, 2); assert.equal(f.task.state, 'error');
    assert.ok(f.manager.view(f.task.id)?.turns[0]?.modelSettings?.effective);
    await assert.rejects(readFile(path.join(f.root, 'requests.jsonl')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('Claude approval grants exactly the displayed command/file request and rejects stale decisions', async () => {
  for (const [tool, decision] of [['Bash', 'accept'], ['Write', 'decline']] as const) {
    const f = await fixture();
    try {
      await f.manager.start(f.task, f.executable, `approve:${tool}`);
      await waitFor(() => !!f.manager.view(f.task.id)?.approvals?.length);
      const approval = f.manager.view(f.task.id)!.approvals![0]!;
      assert.equal(approval.kind, tool === 'Bash' ? 'command' : 'file'); assert.ok(approval.detail.includes('$(keep)'));
      f.manager.approve(f.task.id, approval.id, decision);
      assert.throws(() => f.manager.approve(f.task.id, approval.id, decision), /no longer pending/);
      await f.manager.finished(f.task.id);
      const response = JSON.parse((await readFile(path.join(f.root, 'claude-decisions.jsonl'), 'utf8')).trim()).response;
      assert.equal(response.request_id, 'fixture-approval'); assert.equal(response.response.behavior, decision === 'accept' ? 'allow' : 'deny');
      assert.equal(response.response.updatedPermissions, undefined); assert.equal(response.response.toolUseID, 'fixture-tool-id');
      assert.equal(f.task.state, 'idle'); assert.deepEqual(f.manager.view(f.task.id)?.approvals, []);
      assert.throws(() => f.manager.approve(f.task.id, approval.id, decision), /No active Claude/);
    } finally { await f.close(); }
  }
});
test('Claude unsupported, duplicate, subagent and locally interactive requests never receive a permission grant', async () => {
  for (const [tool, scenario] of [['AskUserQuestion', {}], ['Bash', { duplicateApproval: true }], ['Edit', { approval: { requires_user_interaction: true } }], ['Bash', { approval: { agent_id: 'child' } }]] as const) {
    const f = await fixture(scenario);
    try {
      await f.manager.start(f.task, f.executable, `approve:${tool}`); await f.manager.finished(f.task.id);
      assert.equal(f.task.state, 'error'); await assert.rejects(readFile(path.join(f.root, 'claude-decisions.jsonl')), { code: 'ENOENT' });
    } finally { await f.close(); }
  }
});
test('Claude cancellation removes pending approval and prevents later consent', async () => {
  const f = await fixture({ cancelApproval: true });
  try {
    await f.manager.start(f.task, f.executable, 'approve:Bash');
    await waitFor(() => !!f.manager.view(f.task.id)?.approvals?.length);
    const id = f.manager.view(f.task.id)!.approvals![0]!.id;
    await f.manager.finished(f.task.id);
    assert.deepEqual(f.manager.view(f.task.id)?.approvals, []);
    assert.throws(() => f.manager.approve(f.task.id, id, 'accept'));
    await assert.rejects(readFile(path.join(f.root, 'claude-decisions.jsonl')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
