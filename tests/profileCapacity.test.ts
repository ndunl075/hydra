import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { ProfileCapacity } from '../src/core/profileCapacity';

const id = (value: number) => value.toString(16).padStart(12, '0');
const workspace = (value: number) => value.toString(16).padStart(16, '0');
async function fixture() {
  const base = path.resolve('.test-build/profile-capacity'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'slots ü-'));
  const a = new ProfileCapacity(root, workspace(1)), b = new ProfileCapacity(root, workspace(2));
  return { root, a, b, close: async () => { await a.shutdown(); await b.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
if (process.argv[2] === '--capacity-worker') {
  const capacity = new ProfileCapacity(process.argv[3]!, process.argv[4]!);
  void capacity.tryAcquire(process.argv[5]!, 'managed', 2).then(acquired => {
    process.send?.({ acquired });
    if (!acquired) { void capacity.shutdown().then(() => process.disconnect()); return; }
    process.once('message', () => { void capacity.release(process.argv[5]!).then(() => capacity.shutdown()).then(() => process.disconnect()); });
  }).catch(error => { process.send?.({ error: String(error) }); process.exitCode = 1; process.disconnect(); });
} else {
  test('shutdown fences late completion releases and retains ownership for the next host', async () => {
    const f = await fixture();
    try {
      await f.a.tryAcquire(id(1), 'managed', 2); const original = await readFile(path.join(f.root, '0.json'), 'utf8');
      await f.a.shutdown(); await assert.rejects(f.a.release(id(1), true), /closed/);
      assert.equal(await readFile(path.join(f.root, '0.json'), 'utf8'), original);
    } finally { await f.close(); }
  });
  test('shared capacity races independent instances and cannot acquire a third default slot', async () => {
    const f = await fixture(), actors = Array.from({ length: 8 }, (_, index) => new ProfileCapacity(f.root, workspace(index + 10)));
    try {
      const outcomes = await Promise.all(actors.map((actor, index) => actor.tryAcquire(id(index + 10), 'managed', 2)));
      assert.equal(outcomes.filter(Boolean).length, 2);
      await f.a.refresh(); assert.equal(f.a.view(2).reserved, 2);
      const first = outcomes.findIndex(Boolean); await actors[first]!.release(id(first + 10));
      assert.equal(await f.a.tryAcquire(id(1), 'terminal', 2), true);
      assert.equal(await f.b.tryAcquire(id(2), 'setup', 2), false);
      await f.a.check(id(1), 2);
    } finally { await Promise.all(actors.map(actor => actor.shutdown())); await f.close(); }
  });
  test('separate processes race for exactly two durable reservations until explicitly released', async () => {
    const f = await fixture(), children: ChildProcess[] = [], exits: Promise<unknown>[] = [];
    try {
      const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<boolean>((resolve, reject) => {
        const child = fork(__filename, ['--capacity-worker', f.root, workspace(index + 30), id(index + 30)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child); exits.push(new Promise(resolve => child.once('exit', resolve)));
        const timer = setTimeout(() => reject(new Error('Capacity worker timed out')), 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('message', (value: any) => { clearTimeout(timer); if (value.error) reject(new Error(value.error)); else resolve(value.acquired); });
      })));
      assert.equal(outcomes.filter(Boolean).length, 2);
      await f.a.refresh(); assert.equal(f.a.view(2).reserved, 2);
      assert.equal(await f.a.tryAcquire(id(1), 'managed', 2), false);
      for (const child of children) if (child.connected) child.send('release');
      await Promise.all(exits); await f.a.refresh(); assert.equal(f.a.view(2).reserved, 0);
    } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); await Promise.all(exits); await f.close(); }
  });
  test('foreign and duplicate releases preserve a new claimant token', async () => {
    const f = await fixture();
    try {
      assert.equal(await f.a.tryAcquire(id(1), 'managed', 2), true);
      const original = await readFile(path.join(f.root, '0.json'), 'utf8');
      await f.b.refresh(); await f.b.release(id(1), true);
      assert.equal(await readFile(path.join(f.root, '0.json'), 'utf8'), original);
      await f.a.release(id(1)); assert.equal(await f.b.tryAcquire(id(2), 'setup', 2), true);
      const replacement = await readFile(path.join(f.root, '0.json'), 'utf8');
      await Promise.all([f.a.release(id(1)), f.a.release(id(1))]);
      assert.equal(await readFile(path.join(f.root, '0.json'), 'utf8'), replacement);
      assert.ok(!JSON.stringify(f.b.view(2)).includes(JSON.parse(replacement).token));
      assert.ok(!JSON.stringify(f.b.view(2)).includes(JSON.parse(replacement).host));
    } finally { await f.close(); }
  });
  test('restart has no PID/expiry reclamation and requires explicit owning-workspace absence acknowledgement', async () => {
    const f = await fixture(); let recovered: ProfileCapacity | undefined;
    try {
      await f.a.tryAcquire(id(1), 'terminal', 2); await f.a.shutdown();
      recovered = new ProfileCapacity(f.root, workspace(1)); await recovered.refresh();
      assert.equal(recovered.isUncertain(id(1)), true); assert.equal(recovered.view(2).reserved, 1);
      await assert.rejects(recovered.tryAcquire(id(1), 'terminal', 2), /uncertain/);
      await recovered.release(id(1)); assert.equal(recovered.view(2).reserved, 1);
      await recovered.release(id(1), true); assert.equal(recovered.view(2).reserved, 0);
      assert.equal(await recovered.tryAcquire(id(1), 'managed', 2), true);
    } finally { await recovered?.shutdown(); await f.close(); }
  });
  test('reduced limits prevent new work while older out-of-range reservations remain', async () => {
    const f = await fixture();
    try {
      await f.a.tryAcquire(id(1), 'managed', 2); await f.a.tryAcquire(id(2), 'setup', 2);
      assert.equal(await f.b.tryAcquire(id(3), 'terminal', 1), false);
      await assert.rejects(f.a.check(id(2), 1), /reduced/);
      await f.a.release(id(1)); assert.equal(await f.b.tryAcquire(id(3), 'terminal', 1), false);
      await f.a.check(id(2), 1); await f.a.release(id(2));
      assert.equal(await f.b.tryAcquire(id(3), 'terminal', 1), true);
    } finally { await f.close(); }
  });
  test('uncertain cleanup holds a slot until acknowledged and hold notifications do not loop', async () => {
    const f = await fixture(); let changes = 0;
    const actor = new ProfileCapacity(f.root, workspace(9), () => changes++);
    try {
      await actor.tryAcquire(id(9), 'setup', 1); actor.hold(id(9)); const afterHold = changes; actor.hold(id(9));
      assert.equal(changes, afterHold); assert.equal(actor.isUncertain(id(9)), true);
      await actor.release(id(9)); assert.equal(actor.view(1).reserved, 1);
      await assert.rejects(actor.check(id(9), 1), /verified/);
      assert.equal(await f.a.tryAcquire(id(1), 'managed', 1), false);
      await actor.release(id(9), true); assert.equal(actor.view(1).reserved, 0);
    } finally { await actor.shutdown(); await f.close(); }
  });
  test('missing/replaced owned records refuse launch, and reconciliation never deletes the replacement', async () => {
    const f = await fixture();
    try {
      await f.a.tryAcquire(id(1), 'managed', 2);
      const original = JSON.parse(await readFile(path.join(f.root, '0.json'), 'utf8'));
      await writeFile(path.join(f.root, '0.json'), JSON.stringify({ ...original, workspace: workspace(2), taskId: id(2), token: '11111111-1111-1111-1111-111111111111' }));
      const replacement = await readFile(path.join(f.root, '0.json'), 'utf8');
      await assert.rejects(f.a.check(id(1), 2), /missing or replaced/); assert.equal(f.a.isUncertain(id(1)), true);
      await f.a.release(id(1), true); assert.equal(await readFile(path.join(f.root, '0.json'), 'utf8'), replacement);
      assert.equal(f.a.view(2).reserved, 1);
      await f.b.refresh(); assert.equal(f.b.isUncertain(id(2)), true);
    } finally { await f.close(); }
  });
  test('invalid and oversized records fail closed without deletion or replacement', async () => {
    for (const text of ['{truncated', JSON.stringify({ version: 1, workspace: '../../foreign' }), 'x'.repeat(4097)]) {
      const f = await fixture();
      try {
        await writeFile(path.join(f.root, '0.json'), text);
        await assert.rejects(f.a.tryAcquire(id(1), 'managed', 2), /metadata/);
        assert.equal(f.a.view(2).reserved, null); assert.ok(f.a.view(2).error);
        assert.equal(await readFile(path.join(f.root, '0.json'), 'utf8'), text);
      } finally { await f.close(); }
    }
  });
  test('profile reservation read refuses symlink targets', { skip: process.platform === 'win32' }, async () => {
    const f = await fixture();
    try { const target = path.join(f.root, 'target.json'); await writeFile(target, '{private target}'); await symlink(target, path.join(f.root, '0.json')); await assert.rejects(f.a.tryAcquire(id(1), 'managed', 2), /metadata/); assert.equal(await readFile(target, 'utf8'), '{private target}'); }
    finally { await f.close(); }
  });
  test('watching observes another window release without a provider poll', async () => {
    const f = await fixture(); let changes = 0;
    const observer = new ProfileCapacity(f.root, workspace(8), () => changes++);
    try {
      await f.a.tryAcquire(id(1), 'managed', 1); await observer.refresh(); observer.startWatching(error => { throw error; });
      const before = changes; await f.a.release(id(1));
      const deadline = Date.now() + 5000;
      while (observer.view(1).reserved !== 0) { if (Date.now() > deadline) throw new Error('Watcher did not refresh'); await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.ok(changes > before); assert.equal(await observer.tryAcquire(id(8), 'terminal', 1), true);
    } finally { await observer.shutdown(); await f.close(); }
  });
}
