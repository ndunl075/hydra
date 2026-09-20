import { createHash } from 'node:crypto';
import { createWriteStream, constants } from 'node:fs';
import { mkdir, lstat, open, readdir, realpath, rm, rmdir, stat, statfs } from 'node:fs/promises';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { VerifiedDesktopUpdate } from './desktopSignedUpdate.js';

const maxArtifactBytes = 1024 * 1024 * 1024;
const downloadTimeoutMs = 10 * 60 * 1000;
const maxEnvelopeBytes = 96 * 1024;
const metadataTimeoutMs = 30 * 1000;
const sha256 = /^[a-f0-9]{64}$/;
const operationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function refuse(reason: string): never { throw new Error(`Desktop update staging refused: ${reason}`); }
function validArtifact(update: VerifiedDesktopUpdate): void {
  if (!Number.isSafeInteger(update.artifactBytes) || update.artifactBytes <= 0 || update.artifactBytes > maxArtifactBytes || !sha256.test(update.artifact.sha256)) refuse('artifact bounds are invalid.');
  if (update.artifact.fileName !== 'HydraSetup.exe') refuse('artifact name is invalid.');
}

function installedOrigin(origin: string): URL {
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { return refuse('installed origin is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || isIP(parsed.hostname) || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.localhost')) refuse('installed origin is invalid.');
  return parsed;
}

/** Only installed, reviewed origin data may be passed here. The feed never supplies a URL. */
export function desktopUpdateArtifactUrl(origin: string, update: VerifiedDesktopUpdate): URL {
  installedOrigin(origin);
  validArtifact(update);
  return new URL(`/artifacts/sha256/${update.artifact.sha256}/HydraSetup.exe`, origin);
}

/** Fetches only the fixed channel record; callers must verify its signature before using any field. */
export async function fetchDesktopUpdateEnvelope(origin: string, signal?: AbortSignal, requestFactory: typeof request = request): Promise<Buffer> {
  installedOrigin(origin);
  if (signal?.aborted) refuse('metadata request was cancelled.');
  const url = new URL('/channels/stable/win32-x64/user.json', origin);
  return new Promise<Buffer>((accept, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, metadataTimeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    try {
      const req = requestFactory(url, { method: 'GET', signal: controller.signal, timeout: metadataTimeoutMs, headers: { accept: 'application/json', 'cache-control': 'no-store' } }, response => {
        if (response.statusCode !== 200) { response.destroy(); fail(new Error(`Metadata HTTP ${response.statusCode ?? 'unknown'} refused; redirects are not followed.`)); return; }
        const declared = response.headers['content-length'];
        if (declared !== undefined && (Array.isArray(declared) || !/^\d+$/.test(declared) || Number(declared) > maxEnvelopeBytes)) { response.destroy(); fail(new Error('Metadata Content-Length is invalid.')); return; }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxEnvelopeBytes) { response.destroy(new Error('Metadata exceeds size limit.')); return; }
          chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          cleanup();
          if (bytes === 0 || declared !== undefined && Number(declared) !== bytes) reject(new Error('Metadata response is empty or truncated.'));
          else accept(Buffer.concat(chunks, bytes));
        });
      });
      req.on('error', fail);
      req.end();
    } catch (error) { fail(error); }
  });
}

async function noReparse(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) refuse('staging directory is not a real directory.');
  if (resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) refuse('staging path resolves elsewhere.');
}

function restrictWindowsAcl(path: string): void {
  const system = process.env.SystemRoot || 'C:\\Windows';
  const whoami = join(system, 'System32', 'whoami.exe');
  const icacls = join(system, 'System32', 'icacls.exe');
  const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const match = /"S-1-5-(?:\d+-)+\d+"/.exec(output);
  if (!match) refuse('current Windows identity is unavailable.');
  const sid = match[0].slice(1, -1);
  execFileSync(icacls, [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, timeout: 5000 });
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  if (process.platform === 'win32') restrictWindowsAcl(path);
  await noReparse(path);
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) refuse('staging directory permissions are too broad.');
}

export interface DesktopUpdateStageOptions {
  /** Main-process-owned, already existing user-data directory. */
  userDataDirectory: string;
  /** Immutable installed trust origin, never a feed or renderer value. */
  origin: string;
  update: VerifiedDesktopUpdate;
  /** UUID already committed by the main-owned update operation journal. */
  operationId: string;
  signal?: AbortSignal;
  /** Test seam; production uses Node HTTPS with ordinary TLS validation. */
  requestFactory?: typeof request;
}

export interface StagedDesktopUpdate {
  operationId: string;
  artifactPath: string;
  sha256: string;
  bytes: number;
}

/** Recheck cached bytes before they can be handed to a native verifier. */
export async function verifyStagedDesktopUpdateArtifact(userDataDirectory: string, operationId: string, update: VerifiedDesktopUpdate): Promise<StagedDesktopUpdate> {
  if (typeof userDataDirectory !== 'string' || !isAbsolute(userDataDirectory) || resolve(userDataDirectory) !== userDataDirectory || !operationIdPattern.test(operationId)) refuse('staged operation path is invalid.');
  validArtifact(update);
  const root = join(userDataDirectory, 'hydra-updater');
  const directory = join(root, operationId);
  const artifactPath = join(directory, 'HydraSetup.exe');
  await noReparse(userDataDirectory);
  await noReparse(root);
  await noReparse(directory);
  const info = await lstat(artifactPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== update.artifactBytes) refuse('cached artifact size or type changed.');
  const handle = await open(artifactPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== update.artifactBytes || opened.ino !== info.ino || opened.dev !== info.dev) refuse('cached artifact changed during open.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > update.artifactBytes) refuse('cached artifact exceeds signed length.');
      hash.update(chunk);
    }
    if (bytes !== update.artifactBytes || hash.digest('hex') !== update.artifact.sha256) refuse('cached artifact differs from signed metadata.');
    return { operationId, artifactPath, sha256: update.artifact.sha256, bytes };
  } finally { await handle.close(); }
}

/**
 * Stages verified signed-metadata bytes only. The native helper must rehash,
 * verify Authenticode, and hold the file against replacement before execution.
 */
export async function stageDesktopUpdateArtifact(options: DesktopUpdateStageOptions): Promise<StagedDesktopUpdate> {
  const url = desktopUpdateArtifactUrl(options.origin, options.update);
  if (!operationIdPattern.test(options.operationId)) refuse('staged operation ID is invalid.');
  if (options.signal?.aborted) refuse('download was cancelled.');
  if (typeof options.userDataDirectory !== 'string' || !isAbsolute(options.userDataDirectory)) refuse('user-data path is invalid.');
  const userData = resolve(options.userDataDirectory);
  if (userData !== options.userDataDirectory) refuse('user-data path is invalid.');
  await noReparse(userData);
  const root = join(userData, 'hydra-updater');
  await privateDirectory(root);
  await noReparse(root);
  if ((await readdir(root)).length !== 0) refuse('another staged operation exists.');
  const free = await statfs(root);
  if (Number(free.bavail) * Number(free.bsize) < options.update.artifactBytes + 16 * 1024 * 1024) refuse('insufficient staging disk space.');
  const operationId = options.operationId;
  const operationDirectory = join(root, operationId);
  await privateDirectory(operationDirectory);
  const artifactPath = join(operationDirectory, 'HydraSetup.exe');
  let completed = false;
  try {
    const staged = await new Promise<StagedDesktopUpdate>((accept, reject) => {
      const expectedBytes = options.update.artifactBytes;
      const expectedHash = options.update.artifact.sha256;
      const digest = createHash('sha256');
      let bytes = 0;
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const timer = setTimeout(abort, downloadTimeoutMs);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const transport = options.requestFactory ?? request;
      const requestOptions: RequestOptions = { method: 'GET', signal: controller.signal, timeout: downloadTimeoutMs, headers: { accept: 'application/octet-stream' } };
      let req: ClientRequest;
      try {
        req = transport(url, requestOptions, (response: IncomingMessage) => {
          if (response.statusCode !== 200) { response.destroy(); fail(new Error(`HTTP ${response.statusCode ?? 'unknown'} refused; redirects are not followed.`)); return; }
          const length = response.headers['content-length'];
          if (length !== undefined && (Array.isArray(length) || !/^\d+$/.test(length) || Number(length) !== expectedBytes)) { response.destroy(); fail(new Error('Content-Length does not match signed metadata.')); return; }
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              if (bytes > expectedBytes) { done(new Error('Artifact exceeds signed length.')); return; }
              digest.update(chunk);
              done(null, chunk);
            }
          });
          const output = createWriteStream(artifactPath, { flags: 'wx', mode: 0o600 });
          pipeline(response, counter, output, { signal: controller.signal }).then(() => {
            cleanup();
            if (bytes !== expectedBytes) reject(new Error('Artifact is truncated.'));
            else if (digest.digest('hex') !== expectedHash) reject(new Error('Artifact hash differs from signed metadata.'));
            else accept({ operationId, artifactPath, sha256: expectedHash, bytes });
          }, fail);
        });
        req.on('error', fail);
        req.end();
      } catch (error) { fail(error); }
    });
    completed = true;
    return staged;
  } finally {
    if (!completed) {
      await rm(artifactPath, { force: true });
      await rmdir(operationDirectory);
      await rmdir(root);
    }
  }
}
