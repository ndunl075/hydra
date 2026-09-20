import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopUpdateJournal } from '../src/core/desktopUpdateJournal';
import type { VerifiedDesktopUpdate } from '../src/core/desktopSignedUpdate';

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
