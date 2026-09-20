import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { desktopUpdateArtifactUrl, fetchDesktopUpdateEnvelope, stageDesktopUpdateArtifact, verifyStagedDesktopUpdateArtifact } from '../src/core/desktopUpdateStaging';
import type { VerifiedDesktopUpdate } from '../src/core/desktopSignedUpdate';

const body = Buffer.from('verified Hydra installer fixture');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const update = { artifactBytes: body.length, artifact: { fileName: 'HydraSetup.exe', sha256: digest(body) } } as VerifiedDesktopUpdate;
const origin = 'https://updates.example.com';
const stage = (options: Omit<Parameters<typeof stageDesktopUpdateArtifact>[0], 'operationId'>) =>
  stageDesktopUpdateArtifact({ ...options, operationId: randomUUID() });

function transport(statusCode: number, chunks: Buffer[], headers: Record<string, string> = {}, expectedUrl = `${origin}/artifacts/sha256/${digest(body)}/HydraSetup.exe`) {
  return ((url: URL, options: { signal?: AbortSignal }, callback: (response: IncomingMessage) => void) => {
    assert.equal(url.href, expectedUrl);
    const rawRequest = new EventEmitter() as EventEmitter & { end(): void };
    const response = new PassThrough();
    const incoming = Object.assign(response, { statusCode, headers }) as unknown as IncomingMessage;
    rawRequest.end = () => {
      queueMicrotask(() => {
        callback(incoming);
        for (const chunk of chunks) response.write(chunk);
        response.end();
      });
    };
    options.signal?.addEventListener('abort', () => { response.destroy(); rawRequest.emit('error', new Error('cancelled')); });
    return rawRequest as unknown as ClientRequest;
  }) as typeof httpsRequest;
}

test('fetches only bounded fixed-route metadata before signature verification', async () => {
  const envelope = Buffer.from('{"schemaVersion":1}');
  const route = `${origin}/channels/stable/win32-x64/user.json`;
  assert.deepEqual(await fetchDesktopUpdateEnvelope(origin, undefined, transport(200, [envelope], { 'content-length': String(envelope.length) }, route)), envelope);
  await assert.rejects(fetchDesktopUpdateEnvelope(origin, undefined, transport(302, [], { location: 'https://other.example.com' }, route)), /redirect/);
  await assert.rejects(fetchDesktopUpdateEnvelope(origin, undefined, transport(200, [Buffer.alloc(96 * 1024 + 1)], {}, route)), /size limit/);
  await assert.rejects(fetchDesktopUpdateEnvelope(origin, undefined, transport(200, [envelope], { 'content-length': String(envelope.length + 1) }, route)), /truncated/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchDesktopUpdateEnvelope(origin, controller.signal, transport(200, [envelope], {}, route)), /cancelled/);
});

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-update-stage-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('derives only the immutable hash route from installed origin', () => {
  assert.equal(desktopUpdateArtifactUrl(origin, update).pathname, `/artifacts/sha256/${digest(body)}/HydraSetup.exe`);
  assert.throws(() => desktopUpdateArtifactUrl('http://updates.example.com', update), /origin/);
  assert.throws(() => desktopUpdateArtifactUrl('https://updates.example.com/other', update), /origin/);
  assert.throws(() => desktopUpdateArtifactUrl(origin, { ...update, artifactBytes: 1024 * 1024 * 1024 + 1 }), /bounds/);
});

test('stages exact bytes and refuses pre-existing cache on another operation', async () => fixture(async directory => {
  const staged = await stage({ userDataDirectory: directory, origin, update, requestFactory: transport(200, [body], { 'content-length': String(body.length) }) });
  assert.deepEqual(await readFile(staged.artifactPath), body);
  assert.equal(staged.sha256, digest(body));
  assert.deepEqual(await verifyStagedDesktopUpdateArtifact(directory, staged.operationId, update), staged);
  await writeFile(staged.artifactPath, Buffer.alloc(body.length, 0x41));
  await assert.rejects(verifyStagedDesktopUpdateArtifact(directory, staged.operationId, update), /cached artifact differs/);
  await assert.rejects(stage({ userDataDirectory: directory, origin, update, requestFactory: transport(200, [body]) }), /EEXIST/);
}));

for (const [name, status, chunks, headers, reason] of [
  ['redirect', 302, [], { location: 'https://other.example.com' }, /redirect/],
  ['oversize', 200, [Buffer.concat([body, Buffer.from('extra')])], {}, /exceeds/],
  ['truncation', 200, [body.subarray(0, 4)], {}, /truncated/],
  ['wrong length header', 200, [body], { 'content-length': '2' }, /Content-Length/],
  ['changed bytes', 200, [Buffer.alloc(body.length, 0x41)], {}, /hash differs/]
] as const) {
  test(`refuses ${name} and removes partial staging`, async () => fixture(async directory => {
    await assert.rejects(stage({ userDataDirectory: directory, origin, update, requestFactory: transport(status, [...chunks], headers) }), reason);
    assert.deepEqual(await readdir(directory), []);
  }));
}

test('pre-cancelled operation does not touch staging', async () => fixture(async directory => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(stage({ userDataDirectory: directory, origin, update, signal: controller.signal, requestFactory: transport(200, [body]) }), /cancelled/);
  assert.deepEqual(await readdir(directory), []);
}));

test('cancellation after request creation removes the private operation', async () => fixture(async directory => {
  const controller = new AbortController();
  const waiting = ((url: URL, options: { signal?: AbortSignal }, _callback: (response: IncomingMessage) => void) => {
    assert.equal(url.protocol, 'https:');
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => { queueMicrotask(() => controller.abort()); };
    options.signal?.addEventListener('abort', () => req.emit('error', new Error('cancelled')));
    return req as unknown as ClientRequest;
  }) as typeof httpsRequest;
  await assert.rejects(stage({ userDataDirectory: directory, origin, update, signal: controller.signal, requestFactory: waiting }), /cancelled/);
  assert.deepEqual(await readdir(directory), []);
}));

test('reparse-point user data refuses before download', async () => fixture(async directory => {
  const link = join(directory, 'link');
  await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stage({ userDataDirectory: link, origin, update, requestFactory: transport(200, [body]) }), /real directory|resolves elsewhere/);
}));

test('invalid journal operation ID refuses before staging', async () => fixture(async directory => {
  await assert.rejects(stageDesktopUpdateArtifact({ userDataDirectory: directory, origin, update,
    operationId: '../other', requestFactory: transport(200, [body]) }), /operation ID/);
  assert.deepEqual(await readdir(directory), []);
}));
