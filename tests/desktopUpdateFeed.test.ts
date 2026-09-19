import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseDesktopUpdateFeed } from '../src/core/desktopUpdateFeed';

const product = { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' } as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seal = (manifest: any) => {
  const { sha256: ignored, ...unsigned } = manifest;
  manifest.sha256 = digest(unsigned);
  return manifest;
};
const fixture = () => seal({
  version: 1, product: { ...product }, channel: 'stable',
  release: {
    version: '0.23.0', artifact: { fileName: 'HydraSetup.exe', sha256: 'a'.repeat(64) },
    signature: { status: 'valid', subject: 'CN=Example Publisher', thumbprint: 'B'.repeat(40), artifactSha256: 'a'.repeat(64) },
    provenance: { sourceCommit: 'c'.repeat(40), buildRunId: 123, artifactSha256: 'a'.repeat(64) }
  }, sha256: ''
});
const installed = () => ({ product: { ...product }, channel: 'stable', version: '0.22.0' });

test('describes a newer same-channel Hydra release without an update side effect', () => {
  const update = parseDesktopUpdateFeed(fixture(), installed());
  assert.deepEqual(update, {
    product, channel: 'stable', currentVersion: '0.22.0', availableVersion: '0.23.0',
    artifact: { fileName: 'HydraSetup.exe', sha256: 'a'.repeat(64) },
    signature: { status: 'valid', subject: 'CN=Example Publisher', thumbprint: 'B'.repeat(40), artifactSha256: 'a'.repeat(64) },
    provenance: { sourceCommit: 'c'.repeat(40), buildRunId: 123, artifactSha256: 'a'.repeat(64) }, manifestSha256: fixture().sha256
  });
});

test('refuses rollback, equal versions, and channel crossing', () => {
  const rollback = fixture(); rollback.release.version = '0.21.9'; seal(rollback);
  assert.throws(() => parseDesktopUpdateFeed(rollback, installed()), /not newer/);
  const equal = fixture(); equal.release.version = '0.22.0'; seal(equal);
  assert.throws(() => parseDesktopUpdateFeed(equal, installed()), /not newer/);
  const crossing = fixture(); crossing.channel = 'preview'; seal(crossing);
  assert.throws(() => parseDesktopUpdateFeed(crossing, installed()), /channel crossing/);
});

test('refuses unsigned metadata, an unbound or missing full artifact hash, and altered metadata', () => {
  const unsigned = fixture(); unsigned.release.signature.status = 'unsigned'; seal(unsigned);
  assert.throws(() => parseDesktopUpdateFeed(unsigned, installed()), /unsigned or invalid/);
  const missingHash = fixture(); delete missingHash.release.artifact.sha256; seal(missingHash);
  assert.throws(() => parseDesktopUpdateFeed(missingHash, installed()), /schema/);
  const unbound = fixture(); unbound.release.provenance.artifactSha256 = 'd'.repeat(64); seal(unbound);
  assert.throws(() => parseDesktopUpdateFeed(unbound, installed()), /does not bind/);
  const altered = fixture(); altered.release.version = '0.24.0';
  assert.throws(() => parseDesktopUpdateFeed(altered, installed()), /integrity hash/);
});

test('refuses a wrong product identity, unsupported schema, and malformed signer provenance', () => {
  const wrongProduct = fixture(); wrongProduct.product.nameShort = 'Other'; seal(wrongProduct);
  assert.throws(() => parseDesktopUpdateFeed(wrongProduct, installed()), /product identity/);
  const wrongCurrentProduct = installed(); (wrongCurrentProduct.product as any).applicationName = 'other';
  assert.throws(() => parseDesktopUpdateFeed(fixture(), wrongCurrentProduct), /product identity/);
  const wrongSchema = fixture(); wrongSchema.version = 2; seal(wrongSchema);
  assert.throws(() => parseDesktopUpdateFeed(wrongSchema, installed()), /schema version/);
  const malformedSigner = fixture(); malformedSigner.release.signature.thumbprint = 'bad'; seal(malformedSigner);
  assert.throws(() => parseDesktopUpdateFeed(malformedSigner, installed()), /thumbprint/);
});

test('refuses inherited schema fields and non-plain objects', () => {
  const forged = fixture();
  Object.setPrototypeOf(forged, { version: 1 });
  delete (forged as { version?: number }).version;
  (forged as Record<string, unknown>).extra = 'forged';
  assert.throws(() => parseDesktopUpdateFeed(forged, installed()), /schema/);

  const nullPrototype = Object.assign(Object.create(null), fixture());
  assert.throws(() => parseDesktopUpdateFeed(nullPrototype, installed()), /schema/);
});

test('refuses prerelease numeric identifiers with leading zeroes', () => {
  const malformedCurrent = installed(); malformedCurrent.version = '0.22.0-01';
  assert.throws(() => parseDesktopUpdateFeed(fixture(), malformedCurrent), /current version/);
  const malformedRelease = fixture(); malformedRelease.release.version = '0.23.0-01'; seal(malformedRelease);
  assert.throws(() => parseDesktopUpdateFeed(malformedRelease, installed()), /release version/);
});

test('compares unbounded semantic-version numeric identifiers exactly', () => {
  const coreRelease = fixture();
  coreRelease.release.version = '0.9007199254740993.0';
  seal(coreRelease);
  const coreCurrent = installed(); coreCurrent.version = '0.9007199254740992.0';
  assert.equal(parseDesktopUpdateFeed(coreRelease, coreCurrent).availableVersion, '0.9007199254740993.0');

  const prerelease = fixture();
  prerelease.release.version = '0.22.0-9007199254740993';
  seal(prerelease);
  const prereleaseCurrent = installed(); prereleaseCurrent.version = '0.22.0-9007199254740992';
  assert.equal(parseDesktopUpdateFeed(prerelease, prereleaseCurrent).availableVersion, '0.22.0-9007199254740993');

  const longNumericIdentifier = '9'.repeat(4097);
  const shorterNumericIdentifier = '9'.repeat(4096);
  const longCoreRelease = fixture();
  longCoreRelease.release.version = `0.${longNumericIdentifier}.0`;
  seal(longCoreRelease);
  const longCoreCurrent = installed(); longCoreCurrent.version = `0.${shorterNumericIdentifier}.0`;
  assert.equal(parseDesktopUpdateFeed(longCoreRelease, longCoreCurrent).availableVersion, `0.${longNumericIdentifier}.0`);

  const longPrerelease = fixture();
  longPrerelease.release.version = `0.22.0-${longNumericIdentifier}`;
  seal(longPrerelease);
  const longPrereleaseCurrent = installed(); longPrereleaseCurrent.version = `0.22.0-${shorterNumericIdentifier}`;
  assert.equal(parseDesktopUpdateFeed(longPrerelease, longPrereleaseCurrent).availableVersion, `0.22.0-${longNumericIdentifier}`);
});
