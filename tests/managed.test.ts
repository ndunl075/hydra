import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Task, Turn } from '../src/core/model';
import { ClaudeProtocol, claudeArguments, testedClaudeVersion } from '../src/core/claudeProtocol';
import { SessionStore } from '../src/core/sessionStore';
import { ManagedClaude } from '../src/core/managedClaude';
import { BudgetHoldError } from '../src/core/budgets';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const turn = (): Turn => ({ id: '111111111111', prompt: 'literal prompt', text: '', status: 'running', createdAt: new Date().toISOString() });
const init = (cwd: string) => ({ type: 'system', subtype: 'init', session_id: sessionId, cwd, permissionMode: 'default', claude_code_version: testedClaudeVersion });
const result = (text = 'Hello ü') => ({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: text, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 }, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Edit' }] });
const push = (decoder: ClaudeProtocol, event: unknown) => decoder.push(Buffer.from(JSON.stringify(event) + '\n'));

test('Claude protocol parses split UTF-8, validates identity, reports denials/usage, and keeps unknown events compatible', () => {
  const cwd = path.resolve('.test-build'), current = turn(), decoder = new ClaudeProtocol(current, cwd);
  push(decoder, init(cwd)); push(decoder, { type: 'future_event', extra: 'preserved by raw log' });
  const delta = Buffer.from(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello ü' } } }) + '\n');
  for (const byte of delta) decoder.push(Buffer.from([byte]));
  assert.equal(current.text, 'Hello ü');
  push(decoder, result()); decoder.end();
  assert.equal(decoder.sessionId, sessionId); assert.equal(decoder.resultReceived, true);
  assert.deepEqual(current.usage, { input: 12, output: 3, cacheRead: 4, cacheCreated: undefined, estimatedUsd: 0.01 });
  assert.equal(current.permissionDenials, 1);
  assert.throws(() => push(decoder, result()), /duplicate/);
  for (const invalid of [{ cwd: path.dirname(cwd) }, { claude_code_version: '9.0.0' }, { permissionMode: 'bypassPermissions' }, { session_id: 'bad-id' }]) {
    assert.throws(() => push(new ClaudeProtocol(turn(), cwd), { ...init(cwd), ...invalid }));
  }
  assert.throws(() => push(new ClaudeProtocol(turn(), cwd, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), init(cwd)), /mismatched/);
  assert.throws(() => new ClaudeProtocol(turn(), cwd).push(Buffer.from('not-json\n')));
  assert.throws(() => new ClaudeProtocol(turn(), cwd).push(Buffer.alloc(1024 * 1024 + 1, 120)), /exceeded/);
  assert.throws(() => claudeArguments('../../session'));
  const args = claudeArguments(sessionId);
  assert.equal(args[args.indexOf('--resume') + 1], sessionId);
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(!args.some(arg => arg.includes('skip-permissions') || arg === '--bare'));
});

async function fixture() {
  const base = path.resolve('.test-build', 'managed-fixtures'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'spaces ü-'));
  const script = path.join(root, 'cli.cjs');
  await writeFile(script, await readFile(path.resolve('tests', 'fixtures', 'claude-cli.cjs')));
  const executable = path.join(root, process.platform === 'win32' ? 'cli.cmd' : 'cli');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const task: Task = { id: '222222222222', title: 'Managed', prompt: 'first', repository: root, worktree: root, branch: 'agent/managed', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'claude', providerVersion: testedClaudeVersion, interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { root, executable, task };
}
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for test process.'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
test('Claude budget gate after durable setup prevents spawning a model process', async () => {
  const { root, executable, task } = await fixture();
  const store = new SessionStore(path.join(root, 'sessions'));
  let saved = false;
  const manager = new ManagedClaude(store, async () => { saved = true; }, () => {}, () => {});
  try {
    await assert.rejects(manager.start(task, executable, 'must never submit', () => { assert.ok(saved); throw new BudgetHoldError(['Reached during startup']); }), /Reached during startup/);
    assert.equal(manager.count, 0); await assert.rejects(readFile(path.join(root, 'requests.jsonl')), { code: 'ENOENT' });
    assert.notEqual(manager.view(task.id)?.turns.at(-1)?.status, 'completed');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('managed turns persist raw sequenced evidence, resume explicit IDs, and never invent successful completion', async () => {
  const { root, executable, task } = await fixture();
  const errors: unknown[] = [];
  const store = new SessionStore(path.join(root, 'sessions'));
  const manager = new ManagedClaude(store, async () => { await writeFile(path.join(root, 'task.json'), JSON.stringify(task)); }, () => {}, error => errors.push(error));
  try {
    const starting = manager.start(task, executable, 'first $(literal) ü');
    await assert.rejects(manager.start(task, executable, 'simultaneous duplicate'), /existing task writer/);
    await starting; await manager.finished(task.id);
    assert.equal(task.state, 'idle'); assert.equal(task.sessionId, sessionId);
    assert.equal(manager.view(task.id)?.turns[0]?.status, 'completed');
    const secondPrompt = 'second "quoted" prompt';
    await manager.start(task, executable, secondPrompt); await manager.finished(task.id);
    const requests = (await readFile(path.join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests[0].prompt, 'first $(literal) ü'); assert.equal(requests[1].prompt, secondPrompt);
    assert.equal(requests[1].args[requests[1].args.indexOf('--resume') + 1], sessionId);
    const firstTurn = manager.view(task.id)!.turns[0]!;
    const raw = (await readFile(store.rawPath(task.id, firstTurn.id), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(raw.map(event => event.sequence), raw.map((_, index) => index + 1));
    assert.equal(raw[0].type, 'start'); assert.equal(raw.at(-1).type, 'exit');
    assert.ok(raw.some(event => event.type === 'stdout' && event.data.includes('stream_event')));
    assert.equal((await store.load(task.id)).turns.length, 2);
    for (const prompt of ['noresult', 'badexit', 'malformed']) {
      await manager.start(task, executable, prompt); await manager.finished(task.id);
      assert.equal(task.state, 'error'); assert.equal(manager.view(task.id)!.turns.at(-1)!.status, 'error');
    }
    assert.equal(errors.length, 0);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('stop kills the owned process tree and recovery marks unfinished turns interrupted', async () => {
  const { root, executable, task } = await fixture();
  const store = new SessionStore(path.join(root, 'sessions'));
  const manager = new ManagedClaude(store, async () => {}, () => {}, () => {});
  try {
    await manager.start(task, executable, 'hold');
    await waitFor(async () => { try { await readFile(path.join(root, 'heartbeat.txt')); return true; } catch { return false; } });
    await assert.rejects(manager.start(task, executable, 'duplicate'), /existing task writer/);
    await manager.stop(task.id);
    assert.equal(task.state, 'interrupted'); assert.equal(manager.count, 0);
    const heartbeat = await readFile(path.join(root, 'heartbeat.txt'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await readFile(path.join(root, 'heartbeat.txt'), 'utf8'), heartbeat, 'Grandchild process was stopped');
    const view = manager.view(task.id)!; view.turns.at(-1)!.status = 'running'; await store.save(task.id, view);
    assert.equal((await store.load(task.id)).turns.at(-1)!.status, 'interrupted');
    view.turns[0]!.usage = { input: 'bad' as unknown as number, output: 0 };
    await store.save(task.id, view);
    const invalidMetadata = await readFile(path.join(store.directory(task.id), 'history.json'), 'utf8');
    await assert.rejects(store.load(task.id), /Invalid managed session history/);
    assert.equal(await readFile(path.join(store.directory(task.id), 'history.json'), 'utf8'), invalidMetadata);
    await writeFile(path.join(store.directory(task.id), 'history.json'), '{ corrupt');
    await assert.rejects(store.load(task.id));
    assert.equal(await readFile(path.join(store.directory(task.id), 'history.json'), 'utf8'), '{ corrupt');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
