import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executableFingerprint } from '../src/core/providers';

test('an executable fingerprint changes when the binary is replaced', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-fingerprint-'));
  try {
    const binary = path.join(directory, 'claude.exe');
    await writeFile(binary, 'version one');
    const first = await executableFingerprint(binary);
    assert.equal(await executableFingerprint(binary), first);
    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(binary, 'version two, a different size');
    assert.notEqual(await executableFingerprint(binary), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
