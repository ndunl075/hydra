import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const script = path.join(root, 'scripts', 'desktop-upgrade-evidence.mjs');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  await fs.mkdir(path.join(root, '.test-build'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, '.test-build', 'desktop-upgrade-evidence-'));
  const baseline = {
    version: '0.13.0', headSha: 'a'.repeat(40), runId: 123, artifactId: 456,
    artifactName: 'Hydra-win32-x64-user-installer', artifactDigest: `sha256:${'b'.repeat(64)}`,
    installerSha256: 'c'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z'
  };
  const installer = path.join(directory, 'HydraSetup.exe');
  const priorInstaller = path.join(directory, 'HydraSetup-prior.exe');
  await fs.writeFile(installer, 'current installer');
  await fs.writeFile(priorInstaller, 'prior installer');
  baseline.installerSha256 = digest('prior installer');
  await fs.writeFile(path.join(directory, 'baseline.json'), JSON.stringify(baseline));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '0.22.0' }));
  await fs.writeFile(path.join(directory, 'provenance.json'), JSON.stringify({
    prior: baseline, currentVersion: '0.22.0', currentInstallerSha256: digest('current installer'), runtimeCompared: ['Hydra.exe']
  }));
  await fs.writeFile(path.join(directory, 'output.txt'), 'PASS: pinned Hydra 0.13.0 upgrades to 0.22.0, preserves selected/unselected shortcut preference and user data.');
  const logs = path.join(directory, 'logs');
  await fs.mkdir(logs);
  for (const name of ['shortcut-selected-prior.log', 'shortcut-selected-upgrade.log', 'shortcut-unselected-prior.log', 'shortcut-unselected-upgrade.log']) await fs.writeFile(path.join(logs, name), name);
  return { directory, baseline, installer, priorInstaller, logs };
}

function run(current: Awaited<ReturnType<typeof fixture>>, extra: string[] = []) {
  return spawnSync(process.execPath, [script, '--baseline', path.join(current.directory, 'baseline.json'), '--manifest', path.join(current.directory, 'package.json'), '--provenance', path.join(current.directory, 'provenance.json'), '--output', path.join(current.directory, 'output.txt'), '--logs-dir', current.logs, '--current-installer', current.installer, '--prior-installer', current.priorInstaller, '--now', '2029-01-01T00:00:00.000Z', ...extra], { encoding: 'utf8' });
}

test('records internally consistent hosted-run provenance but leaves acceptance pending', async () => {
  const current = await fixture();
  try {
    const result = run(current);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.priorVersion, '0.13.0');
    assert.equal(record.shortcutCycles.selected, 'recorded');
    assert.equal(record.localParser.acceptance, 'pending-disposable-windows-run');
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

test('fails closed for mismatched versions, expired baselines, wrong hashes, and a missing shortcut cycle', async () => {
  const current = await fixture();
  try {
    await fs.writeFile(path.join(current.directory, 'package.json'), JSON.stringify({ version: '0.13.0' }));
    let result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must differ/);

    await fs.writeFile(path.join(current.directory, 'package.json'), JSON.stringify({ version: '0.22.0' }));
    current.baseline.expiresAt = '2028-01-01T00:00:00.000Z';
    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify(current.baseline));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /has expired/);

    current.baseline.expiresAt = '2030-01-01T00:00:00.000Z';
    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify(current.baseline));
    await fs.writeFile(current.priorInstaller, 'tampered prior installer');
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /prior installer hash does not match/);

    await fs.writeFile(current.priorInstaller, 'prior installer');
    await fs.writeFile(path.join(current.directory, 'provenance.json'), JSON.stringify({ prior: current.baseline, currentVersion: '0.22.0', currentInstallerSha256: 'd'.repeat(64), runtimeCompared: ['Hydra.exe'] }));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /installer hash does not match/);

    await fs.writeFile(path.join(current.directory, 'provenance.json'), JSON.stringify({ prior: current.baseline, currentVersion: '0.22.0', currentInstallerSha256: digest('current installer'), runtimeCompared: ['Hydra.exe'] }));
    await fs.rm(path.join(current.logs, 'shortcut-unselected-upgrade.log'));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /shortcut cycle is missing/);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

test('a published release baseline is pinned by tag, asset and hash, and does not expire', async () => {
  const current = await fixture();
  try {
    const release = { source: 'release', version: '0.13.0', tag: 'v0.13.0', headSha: 'a'.repeat(40), assetName: 'HydraSetup.exe', installerSha256: current.baseline.installerSha256 };
    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify(release));
    await fs.writeFile(path.join(current.directory, 'provenance.json'), JSON.stringify({ prior: release, currentVersion: '0.22.0', currentInstallerSha256: digest('current installer'), runtimeCompared: ['Hydra.exe'] }));
    let result = run(current, ['--now', '2099-01-01T00:00:00.000Z']);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.deepEqual(record.baseline, { source: 'release', headSha: 'a'.repeat(40), tag: 'v0.13.0', assetName: 'HydraSetup.exe', installerSha256: current.baseline.installerSha256 });

    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify({ ...release, tag: 'v0.12.0' }));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /release tag must be v<version>/);

    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify({ ...release, assetName: 'Other.exe' }));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /release asset must be HydraSetup\.exe/);

    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify({ ...release, source: 'somewhere' }));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /source is unknown/);

    await fs.writeFile(path.join(current.directory, 'baseline.json'), JSON.stringify(release));
    await fs.writeFile(path.join(current.directory, 'provenance.json'), JSON.stringify({ prior: { ...release, tag: 'v0.12.0' }, currentVersion: '0.22.0', currentInstallerSha256: digest('current installer'), runtimeCompared: ['Hydra.exe'] }));
    result = run(current);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /prior tag does not match/);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});
