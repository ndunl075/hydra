import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDirectory = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, '..');
const script = path.join(root, 'scripts', 'desktop-signing-preflight.mjs');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const signer = { subject: 'CN=Hydra Test Signing, O=Nico Dunlap', thumbprint: 'A'.repeat(40) };

async function load() {
  return import(pathToFileURL(script).href);
}

async function fixture() {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'desktop-signing-'));
  const content = 'signed installer fixture';
  await fs.writeFile(path.join(directory, 'HydraSetup.exe'), content);
  const manifest = {
    schemaVersion: 1,
    product: { name: 'Hydra', version: '0.22.0' },
    expectedSigner: signer,
    artifacts: [{ path: 'HydraSetup.exe', sha256: digest(content), product: 'Hydra', version: '0.22.0' }]
  };
  const manifestPath = path.join(directory, 'desktop-signing.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { directory, manifest, manifestPath };
}

const valid = async () => ({ status: 'Valid', subject: signer.subject, thumbprint: signer.thumbprint, productName: 'Hydra', productVersion: '0.22.0' });

test('desktop signing preflight binds an exact hash, product/version, and expected signer', async () => {
  const current = await fixture();
  try {
    const { preflight } = await load();
    const before = await fs.readFile(path.join(current.directory, 'HydraSetup.exe'));
    await preflight(current.manifestPath, { inspect: valid });
    assert.deepEqual(await fs.readFile(path.join(current.directory, 'HydraSetup.exe')), before);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

test('desktop signing preflight fails closed for unsigned artifacts and signer or product mismatches', async () => {
  const current = await fixture();
  try {
    const { preflight } = await load();
    await assert.rejects(preflight(current.manifestPath, { inspect: async () => ({ ...(await valid()), status: 'NotSigned' }) }), /unsigned, invalid, or untrusted/);
    await assert.rejects(preflight(current.manifestPath, { inspect: async () => ({ ...(await valid()), subject: 'CN=Someone Else' }) }), /signer does not match/);
    await assert.rejects(preflight(current.manifestPath, { inspect: async () => ({ ...(await valid()), productVersion: '0.22.1' }) }), /product\/version does not match/);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

test('desktop signing preflight fails before signature inspection when an artifact is tampered', async () => {
  const current = await fixture();
  try {
    const { preflight } = await load();
    await fs.writeFile(path.join(current.directory, 'HydraSetup.exe'), 'tampered installer fixture');
    let inspected = false;
    await assert.rejects(preflight(current.manifestPath, { inspect: async () => { inspected = true; return valid(); } }), /artifact hash does not match/);
    assert.equal(inspected, false);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});

test('the command refuses an unsigned local artifact without changing it', async () => {
  const current = await fixture();
  try {
    const before = await fs.readFile(path.join(current.directory, 'HydraSetup.exe'));
    const result = spawnSync(process.execPath, [script, '--manifest', current.manifestPath], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsigned, invalid, or untrusted/);
    assert.deepEqual(await fs.readFile(path.join(current.directory, 'HydraSetup.exe')), before);
  } finally { await fs.rm(current.directory, { recursive: true, force: true }); }
});
