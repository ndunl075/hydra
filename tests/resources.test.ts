import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { TaskResources } from '../src/core/resources';
import { parseResources, resolveSetupCommands, resourceEnvironment } from '../src/core/resourceModel';
import { runSetupCommand } from '../src/core/setupProcess';
import { parseMessage } from '../src/core/model';

const id = '123456789abc', second = 'abcdef123456';
const config = (database = 'task_one', code?: string) => ({ database, commands: code ? [{ executable: process.execPath, args: ['-e', code] }] : [], timeoutMs: 1000 });
async function fixture() { const base = path.resolve('.test-build/resource-fixtures'); await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'run-')); }
async function clean(root: string) { assert.ok(root.startsWith(path.resolve('.test-build/resource-fixtures') + path.sep)); await rm(root, { recursive: true, force: true }); }
const engine = (root: string, owner = 'workspace_one') => new TaskResources(path.join(root, owner), path.join(root, 'leases'), owner);
async function waitFor(predicate: () => Promise<boolean>, duration = 10000) { const until = Date.now() + duration; while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Fixture condition timed out.'); }

test('resources accept only bounded assignments and literal commands; placeholders need assignments', () => {
  const valid = { ...config(), port: 54321, service: 'service_one' };
  assert.deepEqual(resourceEnvironment(parseResources(valid)), { HYDRA_TASK_PORT: '54321', HYDRA_TASK_DATABASE: 'task_one', HYDRA_TASK_SERVICE: 'service_one' });
  assert.equal(parseMessage({ type: 'saveResources', id, config: valid }).type, 'saveResources');
  for (const value of [null, {}, { ...valid, port: 80 }, { ...valid, port: 54321.5 }, { ...valid, database: '../shared' }, { ...valid, service: 'x;echo' }, { ...valid, timeoutMs: 0 }, { ...valid, env: { TOKEN: 'secret' } }, { ...valid, commands: new Array(11).fill({ executable: 'node', args: [] }) }]) assert.throws(() => parseResources(value));
  assert.throws(() => parseMessage({ type: 'runSetup', id: '../escape' }));
  const command = { ...valid, commands: [{ executable: 'node', args: ['literal $(data)', '{{HYDRA_TASK_DATABASE}}:{{HYDRA_TASK_PORT}}'] }] };
  assert.deepEqual(resolveSetupCommands(parseResources(command))[0]?.args, ['literal $(data)', 'task_one:54321']);
  assert.throws(() => resolveSetupCommands(parseResources({ ...command, port: undefined })), /Assign/);
});

test('reservations conflict across workspaces, survive restart, release only owned claims and reacquire saved values', async () => {
  const root = await fixture(), first = engine(root), other = engine(root, 'workspace_two');
  try {
    await first.configure(id, config()); await other.configure(second, config('task_two'));
    await assert.rejects(other.configure(second, config()), /reserved/);
    const resumed = engine(root); await resumed.load(); await resumed.check(id);
    assert.equal(resumed.snapshot()[id]?.config.database, 'task_one');
    await resumed.release(id); assert.throws(() => resumed.assertReady(id), /Reacquire/);
    await other.check(second); await resumed.reacquire(id); await resumed.check(id);
    await resumed.release(id); await other.configure(second, config());
    await assert.rejects(resumed.reacquire(id), /reserved/); await other.check(second);
  } finally { await first.shutdown(); await other.shutdown(); await clean(root); }
});

test('occupied TCP port fails without leaving a reservation; a free port can then be reserved', async () => {
  const root = await fixture(), resources = engine(root), server = createServer();
  try {
    await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await assert.rejects(resources.configure(id, { ...config(), port }), /EADDRINUSE/);
    assert.throws(() => resources.assertReady(id), /Reacquire/);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await resources.configure(id, { ...config(), port }); await resources.check(id);
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await resources.shutdown(); await clean(root); }
});

test('explicit setup uses checkout cwd, saved environment and literal arguments with durable evidence', async () => {
  const root = await fixture(), resources = engine(root);
  try {
    const marker = path.join(root, 'evidence.json');
    const setup = { ...config(), service: 'service_one', commands: [{ executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),db:process.env.HYDRA_TASK_DATABASE,service:process.env.HYDRA_TASK_SERVICE,arg:process.argv[2]}));console.log("setup passed")', marker, 'literal $(data) ü'] }] };
    await resources.configure(id, setup); assert.throws(() => resources.assertReady(id), /Run/);
    await resources.start(id, root, async () => {}); await resources.finished(id); await resources.check(id);
    const evidence = JSON.parse(await readFile(marker, 'utf8')); assert.equal(evidence.cwd.toLowerCase(), root.toLowerCase()); assert.equal(evidence.db, 'task_one'); assert.equal(evidence.service, 'service_one'); assert.equal(evidence.arg, 'literal $(data) ü');
    const saved = resources.snapshot()[id]!; assert.equal(saved.status, 'passed'); assert.match(saved.checks[0]!.stdout, /setup passed/); assert.match(await readFile(saved.log!, 'utf8'), /task_one/);
    const resumed = engine(root); await resumed.load(); await resumed.check(id);
    await resumed.invalidate(id); assert.throws(() => resumed.assertReady(id), /Run/);
  } finally { await resources.shutdown(); await clean(root); }
});

test('failed setup blocks launch and retains its nonzero exit diagnostics', async () => {
  const root = await fixture(), resources = engine(root);
  try { await resources.configure(id, config('task_one', 'console.error("fixture failure");process.exit(7)')); await resources.start(id, root, async () => {}); await resources.finished(id); assert.throws(() => resources.assertReady(id), /Run/); assert.equal(resources.snapshot()[id]?.status, 'failed'); assert.equal(resources.snapshot()[id]?.checks[0]?.exitCode, 7); assert.match(resources.snapshot()[id]!.checks[0]!.stderr, /fixture failure/); const resumed = engine(root); await resumed.load(); assert.throws(() => resumed.assertReady(id)); }
  finally { await resources.shutdown(); await clean(root); }
});

test('timeout, pre-abort and output limits stop explicit commands without unbounded evidence', async () => {
  const root = await fixture();
  try {
    const timed = await runSetupCommand({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},50)'] }, root, {}, new AbortController().signal, 1000, 1024); assert.match(timed.error!, /timed out/);
    const overflow = await runSetupCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(8192));setInterval(()=>{},50)'] }, root, {}, new AbortController().signal, 5000, 1024); assert.match(overflow.error!, /output limit/); assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
    const controller = new AbortController(); controller.abort(); const cancelled = await runSetupCommand({ executable: process.execPath, args: ['-e', 'require("fs").writeFileSync("unexpected","bad")'] }, root, {}, controller.signal, 1000, 1024); assert.match(cancelled.error!, /before command launch/); await assert.rejects(access(path.join(root, 'unexpected')));
  } finally { await clean(root); }
});

test('two setup process trees use distinct resources; stopping one preserves the other', async () => {
  const root = await fixture(), resources = engine(root), markerOne = path.join(root, 'one.txt'), markerTwo = path.join(root, 'two.txt');
  try {
    const script = path.join(root, 'heartbeat.cjs'); await writeFile(script, 'const fs=require("fs");const file=process.argv[2];setInterval(()=>fs.appendFileSync(file,process.env.HYDRA_TASK_DATABASE+"\\n"),40);');
    const parent = 'require("child_process").spawn(process.execPath,[process.argv[1],process.argv[2]],{stdio:"inherit"});setInterval(()=>{},50);';
    const setup = (database: string, marker: string) => ({ ...config(database), timeoutMs: 30000, commands: [{ executable: process.execPath, args: ['-e', parent, script, marker] }] });
    await resources.configure(id, setup('task_one', markerOne)); await resources.configure(second, setup('task_two', markerTwo));
    await resources.start(id, root, async () => {}); await resources.start(second, root, async () => {}); assert.equal(resources.count, 2);
    await waitFor(async () => { try { return (await readFile(markerOne, 'utf8')).length > 0 && (await readFile(markerTwo, 'utf8')).length > 0; } catch { return false; } });
    await assert.rejects(resources.release(id), /Stop/); await resources.stop(id);
    const stopped = await readFile(markerOne, 'utf8'), other = await readFile(markerTwo, 'utf8');
    await waitFor(async () => (await readFile(markerTwo, 'utf8')).length > other.length);
    await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(await readFile(markerOne, 'utf8'), stopped); assert.match(await readFile(markerTwo, 'utf8'), /task_two/); assert.equal(resources.count, 1);
    assert.equal(resources.snapshot()[id]?.status, 'interrupted'); await resources.stop(second); assert.equal(resources.count, 0);
  } finally { await resources.shutdown(); await clean(root); }
});

test('restart retains uncertain setup ownership until explicit reconciliation and a new successful setup', async () => {
  const root = await fixture(), resources = engine(root);
  try {
    await resources.configure(id, config('task_one', 'console.log("ready")')); const file = path.join(root, 'workspace_one', 'resources.json'), data = JSON.parse(await readFile(file, 'utf8')); data.records[id].status = 'running'; await writeFile(file, JSON.stringify(data));
    const resumed = engine(root); await resumed.load(); assert.equal(resumed.snapshot()[id]?.status, 'interrupted'); assert.equal(resumed.count, 1); assert.throws(() => resumed.assertReady(id), /reconcile/); await assert.rejects(resumed.release(id), /reconcile/); await resumed.reconcile(id); assert.equal(resumed.count, 0); assert.throws(() => resumed.assertReady(id), /Run/); await resumed.start(id, root, async () => {}); await resumed.finished(id); await resumed.check(id);
  } finally { await resources.shutdown(); await clean(root); }
});

test('corrupt metadata, escaped log paths and incomplete pass evidence fail closed without overwriting the file', async () => {
  const root = await fixture(), resources = engine(root);
  try {
    await resources.configure(id, config('task_one', 'console.log("ready")')); const file = path.join(root, 'workspace_one', 'resources.json'), original = JSON.parse(await readFile(file, 'utf8'));
    for (const mutate of [(data: any) => data.version = 99, (data: any) => data.records[id].status = 'passed', (data: any) => data.records[id].log = path.join(root, 'workspace_one', 'setups', id, '..', '..', 'outside.jsonl')]) {
      const data = structuredClone(original); mutate(data); const raw = JSON.stringify(data); await writeFile(file, raw); await assert.rejects(engine(root).load()); assert.equal(await readFile(file, 'utf8'), raw);
    }
  } finally { await resources.shutdown(); await clean(root); }
});

test('cancelling during setup preparation starts no command and releases the owned slot', async () => {
  const root = await fixture(), resources = engine(root);
  try {
    await resources.configure(id, config('task_one', 'require("fs").writeFileSync("unexpected","bad")'));
    let prepared!: () => void; const preparing = new Promise<void>(resolve => { prepared = resolve; });
    const start = resources.start(id, root, () => preparing); assert.equal(resources.count, 1);
    const stopped = resources.stop(id); prepared(); await start; await stopped;
    await assert.rejects(access(path.join(root, 'unexpected'))); assert.equal(resources.count, 0); assert.equal(resources.snapshot()[id]?.status, 'interrupted');
  } finally { await resources.shutdown(); await clean(root); }
});

test('failed durable completion keeps setup uncertain and cannot release ownership through failed reconciliation', async () => {
  const root = await fixture(), resources = engine(root);
  try {
    const file = path.join(root, 'workspace_one', 'resources.json');
    await resources.configure(id, config('task_one', `const fs=require('fs');fs.unlinkSync(${JSON.stringify(file)});fs.mkdirSync(${JSON.stringify(file)});console.log('command finished');`));
    await resources.start(id, root, async () => {}); await resources.finished(id);
    assert.equal(resources.count, 1); assert.equal(resources.snapshot()[id]?.uncertain, true); assert.throws(() => resources.assertReady(id), /reconcile/);
    await assert.rejects(resources.reconcile(id)); assert.equal(resources.snapshot()[id]?.uncertain, true); await assert.rejects(resources.release(id), /reconcile/);
  } finally { await resources.shutdown(); await clean(root); }
});
