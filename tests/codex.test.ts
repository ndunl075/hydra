import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetHoldError } from '../src/core/budgets';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CodexMessages, CodexTurn, testedCodexVersion, validateCodexThread } from '../src/core/codexProtocol';
import { ManagedCodex } from '../src/core/managedCodex';
import { ManagedSessions } from '../src/core/managedSessions';
import { SessionStore } from '../src/core/sessionStore';
import { parseMessage, type Task, type Turn } from '../src/core/model';
const threadId = '12345678-1234-7234-9234-123456789abc';
const turnId = 'aaaaaaaa-aaaa-7aaa-9aaa-aaaaaaaaaaaa';
import { terminateProcessTree } from '../src/core/process';

test('Codex awaits the asynchronous final slot guard and Stop during that guard cannot submit a turn', async () => {
  const f = await fixture(); let calls = 0, entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }); const guard = new Promise<void>(resolve => { resume = resolve; });
  try {
    await f.manager.start(f.task, f.executable, 'must not submit', async () => { if (++calls === 2) { entered(); await guard; } });
    await waiting; await f.manager.stop(f.task.id); resume(); await new Promise(resolve => setTimeout(resolve, 25));
    const requests = (await readFile(path.join(f.root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.some(request => request.method === 'turn/start'), false); assert.equal(f.manager.count, 0);
  } finally { resume(); await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

test('Codex cleanup failure is durable and prevents another managed invocation', async () => {
  const f = await fixture(); const errors: unknown[] = [];
  let entered!: () => void, resume!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }); const guard = new Promise<void>(resolve => { resume = resolve; });
  const manager = new ManagedCodex(f.store, async () => {}, () => {}, error => errors.push(error), async pid => { await terminateProcessTree(pid); throw Error('Simulated uncertain child cleanup after safely stopping the fixture tree'); });
  try {
    await manager.start(f.task, f.executable, 'must not submit', async () => { entered(); await guard; }); await waiting; await manager.stop(f.task.id); resume();
    assert.equal(manager.view(f.task.id)?.writerUncertain, true); assert.equal((await f.store.load(f.task.id)).writerUncertain, true);
    assert.equal(errors.length, 1); await assert.rejects(manager.start(f.task, f.executable, 'resume'), /reconcile/);
  } finally { resume(); await manager.shutdown(); await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});
const turn = (): Turn => ({ id: '111111111111', prompt: 'prompt', text: '', status: 'running', createdAt: new Date().toISOString() });

test('Codex framing/turn identity reject mismatched completion and retain authoritative messages and usage', () => {
  const current = turn(), protocol = new CodexTurn(threadId, current);
  protocol.started({ id: turnId, status: 'inProgress' });
  const reader = new CodexMessages(message => protocol.notification(message.method, message.params));
  const emit = (method: string, params: unknown) => Buffer.from(JSON.stringify({ method, params }) + '\n');
  for (const byte of emit('item/agentMessage/delta', { threadId, turnId, itemId: 'one', delta: 'ü text' })) reader.push(Buffer.from([byte]));
  assert.equal(current.text, 'ü text');
  reader.push(emit('item/agentMessage/delta', { threadId: turnId, turnId, itemId: 'two', delta: 'other thread' }));
  assert.equal(current.text, 'ü text');
  reader.push(emit('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'one', text: 'Final ü' } }));
  reader.push(emit('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'two', text: 'Second' } }));
  assert.equal(current.text, 'Final ü\n\nSecond');
  assert.throws(() => reader.push(emit('turn/completed', { threadId, turn: { id: threadId, status: 'completed' } })), /Unmatched/);
  reader.push(emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }));
  assert.equal(current.status, 'completed'); assert.throws(() => reader.push(emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })), /duplicate/);
  assert.throws(() => new CodexMessages(() => {}).push(Buffer.alloc(1024 * 1024 + 1, 120)), /exceeded/);
  assert.throws(() => new CodexMessages(() => {}).push(Buffer.from('not-json\n')));
  const cwd = path.resolve('.test-build');
  const response = { thread: { id: threadId, cwd, cliVersion: testedCodexVersion }, cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } };
  assert.equal(validateCodexThread(response, cwd), threadId);
  for (const bad of [{ cwd: path.dirname(cwd) }, { approvalPolicy: 'never' }, { sandbox: { type: 'dangerFullAccess' } }, { sandbox: { type: 'readOnly' } }]) assert.throws(() => validateCodexThread({ ...response, ...bad }, cwd));
  assert.throws(() => validateCodexThread(response, cwd, turnId), /different thread/);
  assert.throws(() => parseMessage({ type: 'approve', id: '111111111111', approvalId: '222222222222', decision: 'acceptForSession' }));
});
async function fixture() {
  const base = path.resolve('.test-build/codex-fixtures'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'spaces ü-'));
  const script = path.join(root, 'cli.cjs'); await writeFile(script, await readFile('tests/fixtures/codex-cli.cjs'));
  const executable = path.join(root, process.platform === 'win32' ? 'cli.cmd' : 'cli');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const task: Task = { id: '222222222222', title: 'Codex', prompt: 'first', repository: root, worktree: root, branch: 'agent/test', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', providerVersion: testedCodexVersion, interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const store = new SessionStore(path.join(root, 'sessions'));
  const errors: unknown[] = [];
  const persist = async () => { await writeFile(path.join(root, 'task.json'), JSON.stringify(task)); };
  const manager = new ManagedCodex(store, persist, () => {}, error => errors.push(error));
  return { root, executable, task, manager, store, errors, persist };
}
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for Codex test process.'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test('Codex budget gate after thread acknowledgement sends no turn/start and retains native identity', async () => {
  const { root, executable, task, manager } = await fixture();
  let checks = 0;
  try {
    await manager.start(task, executable, 'must never submit', () => { if (++checks === 2) throw new BudgetHoldError(['Reached after thread setup']); });
    await manager.finished(task.id);
    const requests = (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(requests.some(item => item.method === 'thread/start')); assert.ok(!requests.some(item => item.method === 'turn/start'));
    assert.equal(checks, 2); assert.equal(task.sessionId, threadId); assert.equal(manager.count, 0);
    assert.equal(manager.view(task.id)?.turns.at(-1)?.status, 'error');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('Codex managed requests handshake, persist explicit thread resume, and never fabricate successful completion', async () => {
  const { root, executable, task, manager, store, errors } = await fixture();
  try {
    const starting = manager.start(task, executable, 'first $(literal) ü');
    await assert.rejects(manager.start(task, executable, 'duplicate'), /existing task writer/);
    await starting; await manager.finished(task.id);
    assert.equal(task.state, 'idle'); assert.equal(task.sessionId, threadId); assert.equal(task.sessionProvider, 'codex');
    assert.equal(manager.view(task.id)?.turns[0]?.text, 'Codex ü complete');
    assert.deepEqual(manager.view(task.id)?.turns[0]?.usage, { input: 12, output: 4, cacheRead: 3, cacheCreated: 2 });
    await manager.start(task, executable, 'second "quoted" ü'); await manager.finished(task.id);
    const requests = (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests[0].method, 'initialize'); assert.equal(requests[1].method, 'initialized'); assert.ok(requests.find(message => message.method === 'thread/start'));
    assert.equal(requests.find(message => message.method === 'thread/resume').params.threadId, threadId);
    assert.equal(requests.find(message => message.method === 'turn/start').params.input[0].text, 'first $(literal) ü');
    const history = await store.load(task.id); assert.equal(history.turns.length, 2);
    const events = (await readFile(store.rawPath(task.id, history.turns[0]!.id), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1)); assert.equal(events.at(-1).type, 'exit');
    for (const prompt of ['noresult', 'badexit', 'failed', 'malformed', 'unsupported', 'stale', 'file-no-details']) {
      await manager.start(task, executable, prompt); await manager.finished(task.id);
      assert.equal(task.state, 'error', prompt); assert.equal(manager.view(task.id)?.turns.at(-1)?.status, 'error', prompt);
    }
    assert.deepEqual(errors, []);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('Codex approvals bind to live requests, grant one decision, decline, and disappear on interrupt/reload', async () => {
  const { root, executable, task, manager, store } = await fixture();
  try {
    for (const [prompt, decision, kind] of [['approval', 'accept', 'command'], ['decline', 'decline', 'command'], ['network', 'accept', 'network'], ['file', 'decline', 'file']] as const) {
      await manager.start(task, executable, prompt);
      await waitFor(async () => !!manager.view(task.id)?.approvals?.length);
      const approval = manager.view(task.id)!.approvals![0]!;
      assert.equal(approval.kind, kind); assert.ok(approval.detail.includes('Fixture request'));
      if (kind === 'file') { assert.ok(approval.detail.includes('example.txt')); assert.ok(approval.detail.includes('+proposed fixture content')); }
      assert.equal((await store.load(task.id)).approvals, undefined);
      manager.approve(task.id, approval.id, decision);
      assert.throws(() => manager.approve(task.id, approval.id, decision), /no longer pending/);
      await manager.finished(task.id);
      assert.deepEqual(JSON.parse(await readFile(path.join(root, 'approval-result.json'), 'utf8')), { id: 'server-request', result: { decision } });
    }
    await manager.start(task, executable, 'approval'); await waitFor(async () => !!manager.view(task.id)?.approvals?.length);
    const stale = manager.view(task.id)!.approvals![0]!.id;
    await manager.stop(task.id);
    assert.equal(manager.view(task.id)?.turns.at(-1)?.status, 'interrupted'); assert.deepEqual(manager.view(task.id)?.approvals, []);
    assert.throws(() => manager.approve(task.id, stale, 'accept'), /No active/);
    await manager.load(task); assert.equal(manager.view(task.id)?.approvals, undefined);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('Codex incompatible metadata or Windows readiness stops before any model turn', async () => {
  const { root, executable, task, manager } = await fixture();
  try {
    const cases = [{ userAgent: 'hydra/9.0.0' }, { sandbox: 'readOnly' }, { cwd: path.dirname(root) }, { version: '9.0.0' }];
    if (process.platform === 'win32') cases.push({ readiness: 'notConfigured' } as any, { readiness: 'updateRequired' } as any);
    for (const options of cases) {
      await writeFile(path.join(root, 'fixture-options.json'), JSON.stringify(options));
      await manager.start(task, executable, 'do not send'); await manager.finished(task.id);
      assert.equal(task.state, 'error'); assert.equal(task.sessionId, undefined);
    }
    const requests = (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.filter(message => message.method === 'turn/start').length, 0);
    await writeFile(path.join(root, 'fixture-options.json'), JSON.stringify({}));
    await manager.start(task, executable, 'first'); await manager.finished(task.id);
    await writeFile(path.join(root, 'fixture-options.json'), JSON.stringify({ threadId: turnId }));
    await manager.start(task, executable, 'wrong resume'); await manager.finished(task.id);
    assert.equal(task.sessionId, threadId); assert.equal(task.state, 'error');
    const all = (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(all.filter(message => message.method === 'turn/start').length, 1, 'Different returned resume IDs never send a model turn');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('Codex interrupt targets its active turn; fallback stops owned descendants; provider ownership survives migration', async () => {
  const { root, executable, task, manager, store, persist } = await fixture();
  try {
    await manager.start(task, executable, 'hold'); await waitFor(async () => !!task.sessionId && manager.view(task.id)?.turns[0]?.text === 'Streaming ü');
    await manager.stop(task.id); assert.equal(task.state, 'interrupted');
    const requests = (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests.find(message => message.method === 'turn/interrupt').params, { threadId, turnId });
    await manager.start(task, executable, 'force-stop');
    const heartbeat = path.join(root, 'codex-heartbeat.txt');
    await waitFor(async () => { try { return (await readFile(heartbeat)).length > 1; } catch { return false; } });
    await manager.stop(task.id);
    const before = (await readFile(heartbeat)).length; await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await readFile(heartbeat)).length, before); assert.equal(task.state, 'interrupted');
    const sessions = new ManagedSessions(store, persist, () => {}, () => {});
    await sessions.load(task); task.provider = 'claude'; await assert.rejects(sessions.start(task, executable, 'wrong provider'), /another provider/);
    task.sessionProvider = undefined; task.provider = 'codex'; await sessions.load(task);
    assert.equal(task.sessionProvider, 'claude', 'Legacy sessions belonged to Claude even after a Codex handoff');
    await assert.rejects(sessions.start(task, executable, 'wrong legacy provider'), /another provider/);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('Codex awaits durable session observer before turn/start and stops on observer failure', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  const manager = new ManagedCodex(f.store, f.persist, () => {}, error => f.errors.push(error), undefined, {
    sessionIdentified: async (task, id) => { assert.equal(id, threadId); assert.equal(task.sessionId, id); entered(); await blocked; throw Error('Session receipt failed'); }
  });
  try {
    await manager.start(f.task, f.executable, 'must not submit'); await waiting;
    const requests = (await readFile(path.join(f.root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.some(request => request.method === 'turn/start'), false);
    release(); await manager.finished(f.task.id); assert.equal(f.task.state, 'error'); assert.match(f.task.error || '', /Session receipt failed/);
    assert.equal((await readFile(path.join(f.root, 'codex-requests.jsonl'), 'utf8')).includes('turn/start'), false);
  } finally { release(); await manager.shutdown(); await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});
