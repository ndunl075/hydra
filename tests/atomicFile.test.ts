import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { replaceAtomic } from '../src/core/atomicFile';

async function fixture() { const base = path.resolve('.test-build/atomic-fixtures'); await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'replace-')); }
async function clean(root: string) { assert.ok(root.startsWith(path.resolve('.test-build/atomic-fixtures') + path.sep)); await rm(root, { recursive: true, force: true }); }
async function locked(filename: string): Promise<() => Promise<void>> {
  const script = `$lock = [IO.File]::Open('${filename.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null } finally { $lock.Dispose() }`;
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture reader failed'))); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture reader timed out')); }, 5000);
    child.stdout.once('data', data => { clearTimeout(timer); String(data).includes('LOCKED') ? resolve() : reject(new Error('Fixture reader did not acquire lock')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Fixture reader exited before locking')); });
  });
  return async () => { child.stdin.end('release\n'); await exited; };
}

test('atomic replacement preserves the prior record and source when replacement cannot happen', async () => {
  const root = await fixture();
  try {
    const target = path.join(root, 'record.json'), temporary = path.join(root, 'record.tmp');
    await writeFile(target, 'old'); await writeFile(temporary, 'new');
    await assert.rejects(replaceAtomic(temporary, path.join(root, 'missing/record.json')));
    assert.equal(await readFile(target, 'utf8'), 'old'); assert.equal(await readFile(temporary, 'utf8'), 'new');
    await replaceAtomic(temporary, target); assert.equal(await readFile(target, 'utf8'), 'new');
  } finally { await clean(root); }
});

test('Windows atomic replacement waits for a real reader share-lock to clear', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); let release: (() => Promise<void>) | undefined;
  try {
    const target = path.join(root, 'record.json'), temporary = path.join(root, 'record.tmp');
    await writeFile(target, 'old'); await writeFile(temporary, 'new'); release = await locked(target);
    const pending = replaceAtomic(temporary, target); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await readFile(target, 'utf8'), 'old', 'Old record stays readable while replacement waits');
    await release(); release = undefined; await pending;
    assert.equal(await readFile(target, 'utf8'), 'new');
  } finally { await release?.(); await clean(root); }
});

test('Windows permanent share-lock failure is bounded and retains both records for recovery', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture(); let release: (() => Promise<void>) | undefined;
  try {
    const target = path.join(root, 'record.json'), temporary = path.join(root, 'record.tmp');
    await writeFile(target, 'old'); await writeFile(temporary, 'new'); release = await locked(target);
    await assert.rejects(replaceAtomic(temporary, target), error => ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code || ''));
    assert.equal(await readFile(target, 'utf8'), 'old'); assert.equal(await readFile(temporary, 'utf8'), 'new');
    await release(); release = undefined; await replaceAtomic(temporary, target);
    assert.equal(await readFile(target, 'utf8'), 'new');
  } finally { await release?.(); await clean(root); }
});
