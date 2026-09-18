import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMessage, type Task } from '../src/core/model';
import { parseModelSelection, readModelCatalog, requireAdvertisedSelection, verifyEffectiveModel } from '../src/core/modelSelection';
import { discoverCodexModels } from '../src/core/codexModels';
import { ManagedCodex } from '../src/core/managedCodex';
import { SessionStore } from '../src/core/sessionStore';
import { LocalStore } from '../src/core/store';

const id = '111111111111';
const selected = { model: 'fixture-model', effort: 'high' };
const option = (model = 'fixture-model') => ({ model, displayName: model, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' });
async function fixture() {
  const base = path.resolve('.test-build/model-fixtures'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'models-')), script = path.join(root, 'cli.cjs');
  await writeFile(script, await readFile('tests/fixtures/codex-cli.cjs'));
  const executable = path.join(root, process.platform === 'win32' ? 'cli.cmd' : 'cli');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0cli.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const task: Task = { id, title: 'Models', prompt: 'fixture only', repository: root, worktree: root, branch: 'agent/models', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', providerVersion: '0.154.0', interface: 'interactive-cli', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelSelection: selected };
  const store = new SessionStore(path.join(root, 'sessions')), taskStore = new LocalStore(path.join(root, 'tasks')), errors: unknown[] = [];
  const manager = new ManagedCodex(store, () => taskStore.save([task]), () => {}, error => errors.push(error));
  const requests = async () => (await readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const options = (options: unknown) => writeFile(path.join(root, 'fixture-options.json'), JSON.stringify(options));
  const cleanup = async () => { await manager.shutdown(); assert.ok(root.startsWith(base + path.sep)); await rm(root, { recursive: true, force: true }); };
  return { root, executable, task, store, taskStore, manager, requests, options, errors, cleanup };
}

test('model catalog validates paginated advertised choices without invented Astra or effort substitutes', async () => {
  const pages = [{ data: [option()], nextCursor: 'next' }, { data: [{ ...option('hidden-model'), hidden: true }, option('second-model')], nextCursor: null }];
  const calls: unknown[] = [];
  const catalog = await readModelCatalog(async (method, params) => { calls.push({ method, params }); return pages.shift(); });
  assert.deepEqual(catalog.map(model => model.model), ['fixture-model', 'second-model']); assert.equal((calls[1] as any).params.cursor, 'next');
  requireAdvertisedSelection(catalog, selected);
  assert.throws(() => requireAdvertisedSelection(catalog, { model: 'gpt-6-astra', effort: 'high' }), /No model was substituted/);
  assert.throws(() => requireAdvertisedSelection(catalog, { ...selected, effort: 'ultra' }), /does not currently advertise/);
  await assert.rejects(readModelCatalog(async () => ({ data: [option(), option()], nextCursor: null })), /duplicate/);
  await assert.rejects(readModelCatalog(async () => ({ data: [], nextCursor: 'repeat' })), /repeated/);
  await assert.rejects(readModelCatalog(async () => ({ data: [{ ...option(), supportedReasoningEfforts: null }], nextCursor: null })), /Invalid/);
  assert.deepEqual(parseMessage({ type: 'saveModelSelection', id, selection: selected }), { type: 'saveModelSelection', id, selection: selected });
  assert.throws(() => parseModelSelection({ model: 'bad\0model', effort: 'high' }));
  assert.throws(() => verifyEffectiveModel({ model: selected.model, reasoningEffort: 'low' }, selected), /No turn submitted/);
});

test('model discovery sends only metadata RPCs, handles errors, and cancels its owned process', async () => {
  const f = await fixture();
  try {
    assert.equal((await discoverCodexModels(f.executable, f.root))[0]?.model, selected.model);
    assert.deepEqual((await f.requests()).map(message => message.method), ['initialize', 'initialized', 'model/list']);
    await f.options({ catalogError: true }); await assert.rejects(discoverCodexModels(f.executable, f.root), /catalog unavailable/);
    await f.options({ holdCatalog: true });
    const controller = new AbortController(), pending = discoverCodexModels(f.executable, f.root, controller.signal);
    const timer = setTimeout(() => controller.abort(), 500);
    await assert.rejects(pending, /cancelled/); clearTimeout(timer);
    assert.equal((await f.requests()).filter(message => message.method.startsWith('thread/') || message.method.startsWith('turn/')).length, 0);
  } finally { await f.cleanup(); }
});

test('selected Codex model and effort survive resume and are acknowledged before exact turn submission', async () => {
  const f = await fixture();
  try {
    await f.manager.start(f.task, f.executable, 'first'); await f.manager.finished(id);
    assert.equal(f.task.state, 'idle');
    assert.deepEqual(f.manager.view(id)?.turns[0]?.modelSettings, { requested: selected, effective: selected });
    assert.deepEqual((await f.taskStore.load())[0]?.modelSelection, selected);
    await f.manager.load(f.task); await f.manager.start(f.task, f.executable, 'second'); await f.manager.finished(id);
    const requests = await f.requests(), starts = requests.filter(message => message.method === 'turn/start');
    assert.equal(starts.length, 2);
    for (const start of starts) { assert.equal(start.params.model, selected.model); assert.equal(start.params.effort, selected.effort); }
    for (const thread of requests.filter(message => ['thread/start', 'thread/resume'].includes(message.method))) { assert.equal(thread.params.model, selected.model); assert.equal(thread.params.config.model_reasoning_effort, selected.effort); }
    assert.equal(requests.filter(message => message.method === 'model/list').length, 2, 'Catalog is revalidated per turn');
    assert.deepEqual((await f.store.load(id)).turns[1]?.modelSettings, { requested: selected, effective: selected });
    assert.deepEqual(f.errors, []);
  } finally { await f.cleanup(); }
});

test('unavailable choices, missing acknowledgement, and provider clamps never submit a model turn', async () => {
  for (const options of [{ effectiveModel: 'fixture-other' }, { effectiveEffort: 'low' }, { omitModelSettings: true }, { catalog: { data: [], nextCursor: null } }]) {
    const f = await fixture();
    try {
      await f.options(options); await f.manager.start(f.task, f.executable, 'must not submit'); await f.manager.finished(id);
      assert.equal(f.task.state, 'error'); assert.equal((await f.requests()).filter(message => message.method === 'turn/start').length, 0);
      assert.deepEqual(f.manager.view(id)?.turns[0]?.modelSettings?.requested, selected);
    } finally { await f.cleanup(); }
  }
});

test('no selection leaves native defaults untouched; explicit reroutes are visible errors with no corrective turn', async () => {
  const f = await fixture();
  try {
    delete f.task.modelSelection;
    await f.manager.start(f.task, f.executable, 'first'); await f.manager.finished(id);
    for (const request of await f.requests()) if (['thread/start', 'turn/start'].includes(request.method)) {
      assert.equal(request.params.model, undefined); assert.equal(request.params.effort, undefined); assert.equal(request.params.config, undefined);
    }
    assert.equal((await f.requests()).some(message => message.method === 'model/list'), false);
    await f.manager.start(f.task, f.executable, 'reroute'); await f.manager.finished(id);
    assert.equal(f.task.state, 'idle', 'Default configuration can continue after a visible reroute');
    const defaultReroute = (await f.store.load(id)).turns.at(-1)!;
    assert.equal(defaultReroute.modelSettings?.requested, undefined);
    assert.deepEqual(defaultReroute.modelSettings?.effective, { model: 'fixture-fallback', effort: null });
    f.task.modelSelection = selected;
    await f.manager.start(f.task, f.executable, 'reroute'); await f.manager.finished(id);
    assert.equal(f.task.state, 'error');
    const last = (await f.store.load(id)).turns.at(-1)!;
    assert.equal(last.modelSettings?.rerouted?.to, 'fixture-fallback'); assert.equal(last.modelSettings?.effective?.effort, null); assert.match(last.error!, /rerouted/);
    assert.equal((await f.requests()).filter(message => message.method === 'turn/start').length, 3);
  } finally { await f.cleanup(); }
});
