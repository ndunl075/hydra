import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import source from '../desktop/product.json';
import { parseHydraUpdateTrust } from '../desktop/main/hydraUpdateTrust';

const product = () => ({ ...source, hydraVersion: '0.22.0' });
const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const enabled = () => ({ ...product(), hydraUpdateTrust: {
  schemaVersion: 1, status: 'enabled', product: 'Hydra', channel: 'stable',
  target: { platform: 'win32', architecture: 'x64', installTarget: 'user' },
  origin: 'https://updates.example.com', keyId: 'release-1', publicKeyPem: key,
  authenticodeSigners: [{ subject: 'CN=Hydra Fixture', thumbprint: 'A'.repeat(40) }]
} });

test('Electron main keeps the installed disabled channel unavailable', () => {
  assert.equal(parseHydraUpdateTrust(product()), null);
  assert.throws(() => parseHydraUpdateTrust({ ...product(), updateUrl: 'https://upstream.example' }), /invalid/);
  assert.throws(() => parseHydraUpdateTrust({ ...product(), hydraVersion: '1.2.3-beta.1' }), /invalid/);
});

test('Electron main accepts only exact reviewed trust on the Windows user target', () => {
  const trust = parseHydraUpdateTrust(enabled(), 'win32', 'x64');
  assert.equal(trust?.origin, 'https://updates.example.com');
  assert.equal(trust?.version, '0.22.0');
  assert.ok(Object.isFrozen(trust));
  assert.ok(Object.isFrozen(trust?.authenticodeSigners));
  assert.throws(() => parseHydraUpdateTrust(enabled(), 'linux', 'x64'), /invalid/);
  assert.throws(() => parseHydraUpdateTrust(enabled(), 'win32', 'arm64'), /invalid/);
  const wrong = enabled(); wrong.hydraUpdateTrust.origin = 'http://updates.example.com';
  assert.throws(() => parseHydraUpdateTrust(wrong, 'win32', 'x64'), /invalid/);
  wrong.hydraUpdateTrust.origin = 'https://updates.example.com';
  wrong.hydraUpdateTrust.authenticodeSigners[0]!.thumbprint = '0'.repeat(39);
  assert.throws(() => parseHydraUpdateTrust(wrong, 'win32', 'x64'), /invalid/);
  wrong.hydraUpdateTrust.authenticodeSigners[0]!.thumbprint = 'A'.repeat(40);
  wrong.hydraUpdateTrust.publicKeyPem = key.replace('PUBLIC KEY', 'PRIVATE KEY');
  assert.throws(() => parseHydraUpdateTrust(wrong, 'win32', 'x64'), /invalid/);
});
