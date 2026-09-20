import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { VerifiedDesktopUpdate } from '../src/core/desktopSignedUpdate';
import { DesktopUpdateJournal } from '../src/core/desktopUpdateJournal';
import { downloadDesktopUpdateOperation } from '../src/core/desktopUpdateOperation';

const body = Buffer.from('journal-bound staged installer fixture');
const digest = createHash('sha256').update(body).digest('hex');
const origin = 'https://updates.example.com';
const update = {
  sequence: 7, payloadSha256: 'a'.repeat(64), availableVersion: '0.23.0',
  artifactBytes: body.length, artifact: { fileName: 'HydraSetup.exe', sha256: digest }
} as VerifiedDesktopUpdate;

function transport(bytes: Buffer, status = 200, observe: () => void = () => {}): typeof httpsRequest {
  return ((url: URL, _options: unknown, callback: (response: IncomingMessage) => void) => {
    observe();
    assert.equal(url.href, `${origin}/artifacts/sha256/${digest}/HydraSetup.exe`);
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => {
      const stream = new PassThrough();
      callback(Object.assign(stream, { statusCode: status, headers: {} }) as unknown as IncomingMessage);
      stream.end(bytes);
    });
    return req as ClientRequest;
  }) as typeof httpsRequest;
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-update-operation-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('durable UUID names the staged file and downloading is saved before transport', async () => fixture(async directory => {
  const journal = new DesktopUpdateJournal(join(directory, 'hydra-update-state'));
  const operation = await journal.start(update);
  let called = false;
  const staged = await downloadDesktopUpdateOperation({ journal, userDataDirectory: directory, origin, update,
    operationId: operation.id, requestFactory: transport(body, 200, () => {
      called = true;
      const durable = JSON.parse(readFileSync(join(directory, 'hydra-update-state', 'desktop-update-operations.json'), 'utf8'));
      assert.equal(durable.operations.at(-1).phase, 'downloading');
      assert.equal(durable.operations.at(-1).id, operation.id);
    }) });
  assert.equal(called, true);
  assert.equal(staged.operationId, operation.id);
  assert.deepEqual(await readFile(staged.artifactPath), body);
  assert.equal((await journal.load()).at(-1)?.phase, 'downloading');
  assert.deepEqual((await readdir(directory)).sort(), ['hydra-update-state', 'hydra-updater']);
}));

test('stale candidate or failed durable save prevents staging and network', async () => fixture(async directory => {
  let saveAllowed = true;
  const journal = new DesktopUpdateJournal(join(directory, 'hydra-update-state'), async () => {
    if (!saveAllowed) throw new Error('lost owner');
  });
  const operation = await journal.start(update);
  let requests = 0;
  const options = { journal, userDataDirectory: directory, origin, update, operationId: operation.id,
    requestFactory: transport(body, 200, () => { requests++; }) };
  await assert.rejects(downloadDesktopUpdateOperation({ ...options,
    update: { ...update, payloadSha256: 'b'.repeat(64) } }), /does not match/);
  saveAllowed = false;
  await assert.rejects(downloadDesktopUpdateOperation(options), /lost owner/);
  assert.equal(requests, 0);
  assert.equal((await journal.load()).at(-1)?.phase, 'available');
  assert.deepEqual(await readdir(directory), ['hydra-update-state']);
}));

test('failed artifact download is durable failure, never verified or install-ready', async () => fixture(async directory => {
  const journal = new DesktopUpdateJournal(join(directory, 'hydra-update-state'));
  const operation = await journal.start(update);
  await assert.rejects(downloadDesktopUpdateOperation({ journal, userDataDirectory: directory, origin, update,
    operationId: operation.id, requestFactory: transport(body, 302) }), /redirect/);
  assert.equal((await journal.load()).at(-1)?.phase, 'failed');
  assert.deepEqual(await readdir(directory), ['hydra-update-state']);
}));
