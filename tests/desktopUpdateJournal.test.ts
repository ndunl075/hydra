import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdateJournal } from '../src/core/desktopUpdateJournal';
import type { VerifiedDesktopUpdate } from '../src/core/desktopSignedUpdate';
import type { InstalledDesktopUpdateTrust } from '../src/core/desktopSignedUpdate';
import type { DesktopUpdateCurrent } from '../src/core/desktopUpdateFeed';
import { checkDesktopUpdateCandidate } from '../src/core/desktopUpdateCheck';
import { confirmedDesktopUpdateDownload } from '../src/core/desktopUpdateDownloadConsent';
import { hydraUserInstallerAppId, type DesktopInstallIdentity } from '../src/core/desktopInstallIdentity';

const candidate = (sequence = 7): VerifiedDesktopUpdate => ({
  sequence, payloadSha256: 'a'.repeat(64), availableVersion: '0.23.0',
  artifact: { fileName: 'HydraSetup.exe', sha256: 'b'.repeat(64) }, artifactBytes: 100000,
  expectedFiles: [], currentVersion: '0.22.0', channel: 'stable',
  product: { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' },
  signature: { status: 'valid', subject: 'CN=Fixture', thumbprint: 'A'.repeat(40), artifactSha256: 'b'.repeat(64) },
  provenance: { sourceCommit: 'c'.repeat(40), buildRunId: 1, artifactSha256: 'b'.repeat(64) },
  manifestSha256: 'd'.repeat(64)
});
const withJournal = async (run: (journal: DesktopUpdateJournal, directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-update-journal-'));
  try { await run(new DesktopUpdateJournal(directory), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signingKeys = generateKeyPairSync('ed25519');
const signedCurrent: DesktopUpdateCurrent = { product: { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' }, channel: 'stable', version: '0.22.0' };
const signedTrust: InstalledDesktopUpdateTrust = { keyId: 'fixture', publicKeyPem: signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), channel: 'stable', platform: 'win32', architecture: 'x64', installTarget: 'user' };
const signedNow = Date.parse('2026-09-20T00:00:00.000Z');
const installedIdentity: DesktopInstallIdentity = {
  installationPath: 'C:\\Users\\Nico\\AppData\\Local\\Programs\\Hydra',
  executablePath: 'C:\\Users\\Nico\\AppData\\Local\\Programs\\Hydra\\Hydra.exe',
  profilePath: 'C:\\Users\\Nico\\AppData\\Roaming\\Hydra',
  version: '0.22.0', userInstallerAppId: hydraUserInstallerAppId
};
function signedEnvelope(sequence = 7): Buffer {
  const unsigned = { version: 1, product: signedCurrent.product, channel: 'stable', release: {
    version: '0.23.0', artifact: { fileName: 'HydraSetup.exe', sha256: hash('installer') },
    signature: { status: 'valid', subject: 'CN=Fixture', thumbprint: 'A'.repeat(40), artifactSha256: hash('installer') },
    provenance: { sourceCommit: 'c'.repeat(40), buildRunId: 1, artifactSha256: hash('installer') }
  } };
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, target: { platform: 'win32', architecture: 'x64', installTarget: 'user' }, sequence,
    issuedAt: '2026-09-19T00:00:00.000Z', expiresAt: '2026-09-21T00:00:00.000Z', artifactBytes: 100000,
    expectedFiles: [
      { path: 'Hydra.exe', sha256: hash('app') },
      { path: 'resources/app/product.json', sha256: hash('product') },
      { path: 'resources/app/extensions/hydra-agent-manager/package.json', sha256: hash('module') }
    ], manifest: { ...unsigned, sha256: hash(JSON.stringify(unsigned)) } }));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, keyId: signedTrust.keyId, payload: payload.toString('base64'), signature: sign(null, payload, signingKeys.privateKey).toString('base64') }));
}

test('signed check commits availability before reporting it and resumes without another fetch', async () => withJournal(async (journal, directory) => {
  let requests = 0;
  const options = { journal, origin: 'https://updates.example.com', current: signedCurrent, trust: signedTrust, clock: () => signedNow,
    fetchEnvelope: async () => { requests += 1; return signedEnvelope(); } };
  const first = await checkDesktopUpdateCandidate(options);
  assert.equal(first.operation.phase, 'available');
  assert.equal((await new DesktopUpdateJournal(directory).load())[0]!.payloadSha256, first.update.payloadSha256);
  const resumed = await checkDesktopUpdateCandidate(options);
  assert.equal(resumed.operation.id, first.operation.id);
  assert.equal(requests, 1);
  await journal.advance(first.operation.id, 'available', 'downloading');
  await assert.rejects(checkDesktopUpdateCandidate(options), /requires review/);
  assert.equal(requests, 1);
}));

test('invalid signed check never reports or persists availability', async () => withJournal(async (journal) => {
  const raw = signedEnvelope();
  const changed = JSON.parse(raw.toString());
  changed.signature = Buffer.alloc(64).toString('base64');
  await assert.rejects(checkDesktopUpdateCandidate({ journal, origin: 'https://updates.example.com', current: signedCurrent,
    trust: signedTrust, clock: () => signedNow, fetchEnvelope: async () => Buffer.from(JSON.stringify(changed)) }), /signature is invalid/);
  assert.deepEqual(await journal.load(), []);
}));

test('metadata expiring during fetch is rejected at commit time', async () => withJournal(async (journal) => {
  let clock = signedNow;
  await assert.rejects(checkDesktopUpdateCandidate({ journal, origin: 'https://updates.example.com', current: signedCurrent,
    trust: signedTrust, clock: () => clock, fetchEnvelope: async () => {
      clock = Date.parse('2026-09-21T00:00:00.000Z');
      return signedEnvelope();
    } }), /validity window/);
  assert.deepEqual(await journal.load(), []);
}));

test('native cancellation keeps the signed candidate available without staging', async () => withJournal(async (journal, directory) => {
  const operation = await journal.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  let downloads = 0;
  const result = await confirmedDesktopUpdateDownload({ journal, operationId: operation.id, current: signedCurrent,
    trust: signedTrust, clock: () => signedNow, origin: 'https://updates.example.com', userDataDirectory: directory,
    confirm: async update => { assert.equal(update.availableVersion, '0.23.0'); return false; },
    downloadOperation: async () => { downloads++; throw new Error('unexpected download'); } });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(downloads, 0);
  assert.equal((await journal.load())[0]!.phase, 'available');
}));

test('candidate expiring during native confirmation cannot start a download', async () => withJournal(async (journal, directory) => {
  const operation = await journal.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  let clock = signedNow;
  let downloads = 0;
  await assert.rejects(confirmedDesktopUpdateDownload({ journal, operationId: operation.id, current: signedCurrent,
    trust: signedTrust, clock: () => clock, origin: 'https://updates.example.com', userDataDirectory: directory,
    confirm: async () => { clock = Date.parse('2026-09-21T00:00:00.000Z'); return true; },
    downloadOperation: async () => { downloads++; throw new Error('unexpected download'); } }), /validity window/);
  assert.equal(downloads, 0);
  assert.equal((await journal.load())[0]!.phase, 'available');
}));

test('confirmed download passes only the journal-bound signed candidate to staging', async () => withJournal(async (journal, directory) => {
  const operation = await journal.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  let downloads = 0;
  let started = 0;
  const result = await confirmedDesktopUpdateDownload({ journal, operationId: operation.id, current: signedCurrent,
    trust: signedTrust, clock: () => signedNow, origin: 'https://updates.example.com', userDataDirectory: directory,
    confirm: async () => true,
    onDownloadStart: () => { started++; },
    downloadOperation: async options => {
      downloads++;
      options.onDownloadStart?.();
      assert.equal(options.operationId, operation.id);
      assert.equal(options.update.payloadSha256, operation.payloadSha256);
      assert.equal(options.origin, 'https://updates.example.com');
      return { operationId: operation.id, artifactPath: join(directory, 'fixture'), sha256: options.update.artifact.sha256, bytes: options.update.artifactBytes };
    } });
  assert.equal(result.status, 'staged');
  assert.equal(downloads, 1);
  assert.equal(started, 1);
}));

test('persists the exact signed candidate and reauthenticates after restart', async () => withJournal(async (journal, directory) => {
  const accepted = await journal.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  const restored = new DesktopUpdateJournal(directory);
  assert.equal((await restored.loadSignedCandidate(accepted.id, signedCurrent, signedTrust, signedNow)).payloadSha256, accepted.payloadSha256);
  await assert.rejects(restored.loadSignedCandidate(accepted.id, signedCurrent, signedTrust, Date.parse('2026-09-21T00:00:00.000Z')), /validity window/);
  const file = join(directory, 'desktop-update-operations.json');
  const tampered = JSON.parse(await readFile(file, 'utf8'));
  tampered.operations[0].signedEnvelope = signedEnvelope(8).toString('base64');
  await writeFile(file, JSON.stringify(tampered));
  await assert.rejects(restored.loadSignedCandidate(accepted.id, signedCurrent, signedTrust, signedNow), /binding changed/);
  await writeFile(file, JSON.stringify({ ...tampered, operations: [{ ...tampered.operations[0], signedEnvelope: accepted.signedEnvelope }] }));
  await restored.advance(accepted.id, 'available', 'failed', { reason: 'cancelled' });
  assert.equal((await restored.load())[0]!.signedEnvelope, null);
  await assert.rejects(restored.loadSignedCandidate(accepted.id, signedCurrent, signedTrust, signedNow), /unavailable/);
}));

test('persists authorization marker and refuses replay or unreviewed restart recovery', async () => withJournal(async (journal, directory) => {
  const started = await journal.start(candidate());
  await assert.rejects(journal.start(candidate(8)), /active operation/);
  await journal.advance(started.id, 'available', 'downloading');
  await journal.advance(started.id, 'downloading', 'verified');
  await assert.rejects(journal.advance(started.id, 'verified', 'awaitingRestart'), /authorization timestamp/);
  const authorizedAt = '2026-09-20T17:00:00.000Z';
  await journal.advance(started.id, 'verified', 'awaitingRestart', { authorizedAt });
  assert.equal((await new DesktopUpdateJournal(directory).recovery()).status, 'review');
  await journal.advance(started.id, 'awaitingRestart', 'installing');
  assert.equal((await new DesktopUpdateJournal(directory).recovery()).status, 'review');
  await assert.rejects(journal.advance(started.id, 'awaitingRestart', 'installed'), /stale/);
  await journal.advance(started.id, 'installing', 'installed');
  assert.equal((await journal.recovery()).status, 'review');
  await journal.advance(started.id, 'installed', 'healthy');
  assert.equal((await journal.recovery()).status, 'none');
  await assert.rejects(journal.start(candidate()), /sequence/);
  assert.equal((await journal.start(candidate(8))).sequence, 8);
}));

test('corrupt journal and retained writer lock refuse without erasing evidence', async () => withJournal(async (journal, directory) => {
  const started = await journal.start(candidate());
  const file = join(directory, 'desktop-update-operations.json');
  const original = await readFile(file);
  await writeFile(file, '{"version":1,"operations":[{"id":"bad"}]}');
  await assert.rejects(journal.recovery(), /schema|operation record/);
  await assert.rejects(journal.advance(started.id, 'available', 'downloading'), /schema|operation record/);
  assert.match((await readFile(file, 'utf8')), /"bad"/);
  await writeFile(file, original);
  const lock = `${file}.lock`;
  await writeFile(lock, 'other-owner', { flag: 'wx' });
  await assert.rejects(journal.advance(started.id, 'available', 'downloading'), /retained lock/);
  assert.deepEqual(await readFile(file), original);
}));

test('failed durable ownership check leaves prior phase intact', async () => withJournal(async (_journal, directory) => {
  let allow = true;
  const journal = new DesktopUpdateJournal(directory, async () => { if (!allow) throw new Error('lost writer'); });
  const started = await journal.start(candidate());
  allow = false;
  await assert.rejects(journal.advance(started.id, 'available', 'downloading'), /lost writer/);
  assert.equal((await new DesktopUpdateJournal(directory).load())[0]!.phase, 'available');
}));

test('installed journal binds a signed candidate to the observed installation across restart', async () => withJournal(async (_journal, directory) => {
  const bound = () => new DesktopUpdateJournal(directory, undefined, async () => installedIdentity);
  const first = await bound().startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  const persisted = JSON.parse(await readFile(join(directory, 'desktop-update-operations.json'), 'utf8'));
  assert.equal(persisted.version, 3);
  assert.equal(persisted.operations[0].installation.policyVersion, 1);
  assert.equal(persisted.operations[0].installation.profilePath, installedIdentity.profilePath);
  assert.equal((await bound().loadSignedCandidate(first.id, signedCurrent, signedTrust, signedNow)).payloadSha256, first.payloadSha256);
  assert.equal((await new DesktopUpdateJournal(directory, undefined, async () => ({ ...installedIdentity, version: '0.23.0' })).load())[0]!.id, first.id);
  const relocated = new DesktopUpdateJournal(directory, undefined, async () => ({ ...installedIdentity, profilePath: 'C:\\Other\\Hydra' }));
  await assert.rejects(relocated.load(), /installation identity.*changed/);
  assert.equal((await relocated.recovery()).status, 'review');
  await assert.rejects(relocated.advance(first.id, 'available', 'downloading'), /installation identity.*changed/);
  assert.equal((await bound().load())[0]!.phase, 'available');
}));

test('edited persisted installation cannot authorize resumed work', async () => withJournal(async (_journal, directory) => {
  const bound = new DesktopUpdateJournal(directory, undefined, async () => installedIdentity);
  const first = await bound.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  const file = join(directory, 'desktop-update-operations.json');
  const changed = JSON.parse(await readFile(file, 'utf8'));
  changed.operations[0].installation.executablePath = 'C:\\Other\\Hydra.exe';
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(bound.loadSignedCandidate(first.id, signedCurrent, signedTrust, signedNow), /installation identity.*changed/);
  assert.equal((await bound.recovery()).status, 'review');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).operations[0].installation.executablePath, 'C:\\Other\\Hydra.exe');
}));

test('legacy unbound operation stays review-only without rewriting journal evidence', async () => withJournal(async (journal, directory) => {
  await journal.startSigned(signedEnvelope(), signedCurrent, signedTrust, signedNow);
  const file = join(directory, 'desktop-update-operations.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  legacy.version = 2;
  delete legacy.operations[0].installation;
  await writeFile(file, JSON.stringify(legacy));
  const original = await readFile(file);
  const bound = new DesktopUpdateJournal(directory, undefined, async () => installedIdentity);
  assert.equal((await bound.recovery()).status, 'review');
  await assert.rejects(bound.load(), /unbound.*review/);
  await assert.rejects(bound.startSigned(signedEnvelope(8), signedCurrent, signedTrust, signedNow), /unbound.*review/);
  assert.deepEqual(await readFile(file), original);
}));

test('installation changing during a journal write keeps the prior durable state', async () => withJournal(async (_journal, directory) => {
  let calls = 0;
  const bound = new DesktopUpdateJournal(directory, undefined, async () => {
    calls++;
    return calls === 1 ? installedIdentity : { ...installedIdentity, installationPath: 'C:\\Other\\Hydra' };
  });
  await assert.rejects(bound.start(candidate()), /installation changed during save/);
  assert.deepEqual(await new DesktopUpdateJournal(directory).load(), []);
}));
