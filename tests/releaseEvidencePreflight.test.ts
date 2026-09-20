import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'verify-release-evidence.ps1');
const windowsTest = process.platform === 'win32' ? test : test.skip;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'release-evidence-'));
  const files = {
    installer: 'current installer', runtime: 'current runtime', selected: 'selected shortcut proof',
    unselected: 'unselected shortcut proof', prior: 'prior installer'
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, `${name}.bin`), content);
  const file = (name: keyof typeof files) => ({ path: `${name}.bin`, sha256: digest(files[name]) });
  const manifest = {
    schemaVersion: 1,
    installer: file('installer'), runtime: [file('runtime')],
    shortcutClaims: [{ selected: false, evidence: file('unselected') }, { selected: true, evidence: file('selected') }],
    priorVersionBaseline: { version: '0.13.0', sourceCommit: 'a'.repeat(40), installer: file('prior') },
    gates: { signing: 'verified', manual: [{ id: 'distinct-version-upgrade', status: 'verified' }, { id: 'installer-wizard', status: 'verified' }] }
  };
  const manifestPath = path.join(directory, 'release-evidence.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath };
}

function preflight(manifestPath: string) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ManifestPath', manifestPath, '-WhatIf'], { encoding: 'utf8' });
}

windowsTest('release evidence preflight verifies local hashes without changing evidence files', async () => {
  const current = await fixture();
  try {
    const before = await fs.readFile(path.join(current.directory, 'installer.bin'));
    const result = preflight(current.manifestPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release evidence preflight passed/);
    assert.deepEqual(await fs.readFile(path.join(current.directory, 'installer.bin')), before);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

windowsTest('release evidence preflight fails closed for missing signing, pending manual gates, and mismatched shortcut evidence', async () => {
  const current = await fixture();
  try {
    current.manifest.gates.signing = 'missing';
    await fs.writeFile(current.manifestPath, JSON.stringify(current.manifest));
    let result = preflight(current.manifestPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signing gate is missing/);

    current.manifest.gates.signing = 'verified';
    current.manifest.gates.manual[0]!.status = 'pending';
    await fs.writeFile(current.manifestPath, JSON.stringify(current.manifest));
    result = preflight(current.manifestPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manual release gate distinct-version-upgrade is\s+pending/);

    current.manifest.gates.manual[0]!.status = 'verified';
    current.manifest.shortcutClaims[0]!.evidence.sha256 = 'b'.repeat(64);
    await fs.writeFile(current.manifestPath, JSON.stringify(current.manifest));
    result = preflight(current.manifestPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shortcut claim \(False\) hash does not match/);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

windowsTest('release evidence preflight rejects a junction or link that escapes the manifest directory', async t => {
  const current = await fixture();
  const outside = await fs.mkdtemp(path.join(path.dirname(current.directory), 'release-evidence-outside-'));
  try {
    const outsideFile = path.join(outside, 'outside.bin');
    await fs.writeFile(outsideFile, 'outside evidence');
    try { await fs.symlink(outside, path.join(current.directory, 'linked'), 'junction'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') { t.skip(`Link fixtures are unavailable: ${code}`); return; }
      throw error;
    }
    current.manifest.runtime = [{ path: 'linked/outside.bin', sha256: digest('outside evidence') }];
    await fs.writeFile(current.manifestPath, JSON.stringify(current.manifest));
    const result = preflight(current.manifestPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime evidence traverses a reparse point/);
  } finally {
    await fs.rm(current.directory, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
