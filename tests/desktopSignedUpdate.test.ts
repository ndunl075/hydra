import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verifyDesktopSignedUpdate, type DesktopUpdateSequenceFloor, type InstalledDesktopUpdateTrust } from '../src/core/desktopSignedUpdate';
import type { DesktopUpdateCurrent } from '../src/core/desktopUpdateFeed';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const artifactHash = hash('signed-installer-fixture');
const product = { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' } as const;
const current: DesktopUpdateCurrent = { product, channel: 'stable', version: '0.22.0' };
const trust: InstalledDesktopUpdateTrust = {
  keyId: 'hydra-test-key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  channel: 'stable', platform: 'win32', architecture: 'x64', installTarget: 'user'
};
const now = Date.parse('2026-09-20T00:00:00.000Z');

function payload() {
  const unsigned = {
    version: 1, product, channel: 'stable',
    release: {
      version: '0.23.0', artifact: { fileName: 'HydraSetup.exe', sha256: artifactHash },
      signature: { status: 'valid', subject: 'CN=Fixture', thumbprint: 'A'.repeat(40), artifactSha256: artifactHash },
      provenance: { sourceCommit: 'b'.repeat(40), buildRunId: 42, artifactSha256: artifactHash }
    }
  };
  return {
    schemaVersion: 1,
    target: { platform: 'win32', architecture: 'x64', installTarget: 'user' },
    sequence: 7,
    issuedAt: '2026-09-19T00:00:00.000Z',
    expiresAt: '2026-09-21T00:00:00.000Z',
    artifactBytes: 100000,
    expectedFiles: [
      { path: 'Hydra.exe', sha256: hash('app') },
      { path: 'resources/app/product.json', sha256: hash('product') },
      { path: 'resources/app/extensions/hydra-agent-manager/package.json', sha256: hash('module') }
    ],
    manifest: { ...unsigned, sha256: hash(JSON.stringify(unsigned)) }
  };
}
function envelope(value = payload(), signer = keys.privateKey): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, keyId: trust.keyId, payload: bytes.toString('base64'),
    signature: sign(null, bytes, signer).toString('base64')
  }));
}
function refuses(value: Buffer, reason: RegExp, floor: DesktopUpdateSequenceFloor | null = null, chosenCurrent = current, chosenTrust = trust, clock = now) {
  assert.throws(() => verifyDesktopSignedUpdate(value, chosenCurrent, chosenTrust, floor, clock), reason);
}

test('accepts a signed stable release and exact same-sequence resume', () => {
  const signed = envelope();
  const result = verifyDesktopSignedUpdate(signed, current, trust, null, now);
  assert.equal(result.availableVersion, '0.23.0');
  assert.equal(result.artifactBytes, 100000);
  assert.deepEqual(result.expectedFiles.map(file => file.path), [
    'Hydra.exe', 'resources/app/product.json', 'resources/app/extensions/hydra-agent-manager/package.json'
  ]);
  assert.equal(verifyDesktopSignedUpdate(signed, current, trust, { sequence: 7, payloadSha256: result.payloadSha256 }, now).payloadSha256, result.payloadSha256);
});

test('rejects altered signatures, wrong keys, duplicate JSON keys, and oversized envelopes', () => {
  const signed = envelope();
  const changed = JSON.parse(signed.toString());
  changed.signature = sign(null, Buffer.from('different'), keys.privateKey).toString('base64');
  refuses(Buffer.from(JSON.stringify(changed)), /signature is invalid/);
  refuses(envelope(payload(), otherKeys.privateKey), /signature is invalid/);
  refuses(Buffer.from(signed.toString().replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')), /not canonical/);
  refuses(Buffer.alloc(96 * 1024 + 1, 65), /envelope size/);
  refuses(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), signed]), /BOM/);
  refuses(Buffer.from('['.repeat(12000) + '0' + ']'.repeat(12000)), /nesting limit/);
  const duplicatePayload = Buffer.from(JSON.stringify(payload()).replace('"sequence":7,', '"sequence":7,"sequence":7,'));
  refuses(Buffer.from(JSON.stringify({ schemaVersion: 1, keyId: trust.keyId, payload: duplicatePayload.toString('base64'), signature: sign(null, duplicatePayload, keys.privateKey).toString('base64') })), /not canonical/);
  const deepPayload = Buffer.from('{"schemaVersion":1,"extra":' + '['.repeat(32) + '0' + ']'.repeat(32) + '}');
  refuses(Buffer.from(JSON.stringify({ schemaVersion: 1, keyId: trust.keyId, payload: deepPayload.toString('base64'), signature: sign(null, deepPayload, keys.privateKey).toString('base64') })), /nesting limit/);
});

test('rejects wrong target, channel, expiry, stable prerelease, and non-newer release', () => {
  const wrongTarget = payload(); wrongTarget.target.architecture = 'arm64';
  refuses(envelope(wrongTarget), /target does not match/);
  const wrongChannel = payload(); wrongChannel.manifest.channel = 'preview';
  refuses(envelope(wrongChannel), /channel does not match/);
  refuses(envelope(), /validity window/, null, current, trust, Date.parse('2026-09-21T00:00:00.000Z'));
  const prerelease = payload(); prerelease.manifest.release.version = '0.23.0-beta.1';
  const { sha256: _oldHash, ...unsignedPre } = prerelease.manifest;
  prerelease.manifest.sha256 = hash(JSON.stringify(unsignedPre));
  refuses(envelope(prerelease), /stable artifact is invalid/);
  refuses(envelope(), /not newer/, null, { ...current, version: '0.23.0' });
});

test('rejects sequence rollback, equivocation, and malformed installed inventory', () => {
  const signed = envelope();
  const accepted = verifyDesktopSignedUpdate(signed, current, trust, null, now);
  refuses(signed, /replay or equivocation/, { sequence: 8, payloadSha256: accepted.payloadSha256 });
  const changed = payload(); changed.artifactBytes += 1;
  refuses(envelope(changed), /replay or equivocation/, { sequence: 7, payloadSha256: accepted.payloadSha256 });
  const wrongInventory = payload(); wrongInventory.expectedFiles[0]!.path = '../Hydra.exe';
  refuses(envelope(wrongInventory), /installed-file inventory/);
});
