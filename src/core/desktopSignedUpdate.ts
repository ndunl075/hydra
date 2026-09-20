import { createHash, createPublicKey, verify } from 'node:crypto';
import { parseDesktopUpdateFeed, type DesktopAvailableUpdate, type DesktopUpdateCurrent, type DesktopUpdateManifest } from './desktopUpdateFeed';

export interface InstalledDesktopUpdateTrust {
  keyId: string;
  publicKeyPem: string;
  channel: 'stable';
  platform: 'win32';
  architecture: 'x64';
  installTarget: 'user';
}

export interface DesktopUpdateSequenceFloor {
  sequence: number;
  payloadSha256: string;
}

export interface VerifiedDesktopUpdate extends DesktopAvailableUpdate {
  sequence: number;
  payloadSha256: string;
  artifactBytes: number;
  expectedFiles: ReadonlyArray<{ path: string; sha256: string }>;
}

const maxEnvelopeBytes = 96 * 1024;
const maxPayloadBytes = 64 * 1024;
const maxJsonDepth = 16;
const sha256 = /^[a-f0-9]{64}$/;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const installedPaths = [
  'Hydra.exe',
  'resources/app/product.json',
  'resources/app/extensions/hydra-agent-manager/package.json'
] as const;

function refuse(reason: string): never { throw new Error(`Signed desktop update refused: ${reason}`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) refuse('schema is invalid.');
  return value as Record<string, unknown>;
}
function boundJsonDepth(bytes: Buffer): void {
  let depth = 0; let quoted = false; let escaped = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) quoted = false;
    } else if (byte === 0x22) quoted = true;
    else if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      if (depth > maxJsonDepth) refuse('JSON nesting limit exceeded.');
    } else if (byte === 0x7d || byte === 0x5d) depth -= 1;
  }
}
function json(bytes: Buffer): unknown {
  boundJsonDepth(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse('UTF-8 BOM is not allowed.');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return refuse('UTF-8 is invalid.'); }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { return refuse('JSON is invalid.'); }
  // An exact JSON.stringify round trip refuses duplicate keys, alternate
  // number spellings and changed escapes before parsed fields gain authority.
  if (JSON.stringify(value) !== source) refuse('JSON encoding is not canonical.');
  return value;
}
function decode(value: unknown, maximum: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4 || !base64.test(value)) refuse(`${label} encoding is invalid.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) refuse(`${label} encoding is invalid.`);
  return bytes;
}
function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) refuse(`${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) refuse(`${label} is invalid.`);
  return parsed;
}
function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) refuse('release sequence is invalid.');
  return value as number;
}

/**
 * Verifies only a caller-supplied, bounded release record. Installed trust and
 * the durable sequence floor must come from the native host, never a feed or
 * renderer. This function does not fetch, persist, stage, or install anything.
 */
export function verifyDesktopSignedUpdate(
  rawEnvelope: Buffer,
  current: DesktopUpdateCurrent,
  trust: InstalledDesktopUpdateTrust,
  floor: DesktopUpdateSequenceFloor | null,
  now: number
): VerifiedDesktopUpdate {
  if (!Buffer.isBuffer(rawEnvelope) || rawEnvelope.length === 0 || rawEnvelope.length > maxEnvelopeBytes) refuse('envelope size is invalid.');
  if (!Number.isSafeInteger(now) || now < 0) refuse('clock is invalid.');
  const envelope = record(json(rawEnvelope), ['schemaVersion', 'keyId', 'payload', 'signature']);
  if (envelope.schemaVersion !== 1 || typeof envelope.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(envelope.keyId) || envelope.keyId !== trust.keyId) refuse('metadata key is invalid.');
  const payloadBytes = decode(envelope.payload, maxPayloadBytes, 'payload');
  const signature = decode(envelope.signature, 64, 'signature');
  if (signature.length !== 64) refuse('signature length is invalid.');
  let key;
  try { key = createPublicKey(trust.publicKeyPem); }
  catch { return refuse('installed public key is invalid.'); }
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payloadBytes, key, signature)) refuse('metadata signature is invalid.');

  const payload = record(json(payloadBytes), ['schemaVersion', 'target', 'sequence', 'issuedAt', 'expiresAt', 'artifactBytes', 'expectedFiles', 'manifest']);
  if (payload.schemaVersion !== 1) refuse('payload version is unsupported.');
  const target = record(payload.target, ['platform', 'architecture', 'installTarget']);
  if (trust.channel !== 'stable' || trust.platform !== 'win32' || trust.architecture !== 'x64' || trust.installTarget !== 'user' || target.platform !== trust.platform || target.architecture !== trust.architecture || target.installTarget !== trust.installTarget || current.channel !== trust.channel) refuse('installed update target does not match.');
  const issuedAt = timestamp(payload.issuedAt, 'issue time');
  const expiresAt = timestamp(payload.expiresAt, 'expiry time');
  if (expiresAt <= issuedAt || now < issuedAt || now >= expiresAt) refuse('metadata is outside its validity window.');
  const releaseSequence = sequence(payload.sequence);
  const payloadSha256 = createHash('sha256').update(payloadBytes).digest('hex');
  if (floor !== null) {
    record(floor, ['sequence', 'payloadSha256']);
    if (!Number.isSafeInteger(floor.sequence) || floor.sequence <= 0 || !sha256.test(floor.payloadSha256)) refuse('stored sequence floor is invalid.');
    if (releaseSequence < floor.sequence || releaseSequence === floor.sequence && payloadSha256 !== floor.payloadSha256) refuse('release sequence replay or equivocation.');
  }
  if (!Number.isSafeInteger(payload.artifactBytes) || (payload.artifactBytes as number) <= 0) refuse('artifact length is invalid.');
  if (!Array.isArray(payload.expectedFiles) || payload.expectedFiles.length !== installedPaths.length) refuse('installed-file inventory is invalid.');
  const expectedFiles = installedPaths.map((name, index) => {
    const file = record((payload.expectedFiles as unknown[])[index], ['path', 'sha256']);
    if (file.path !== name || typeof file.sha256 !== 'string' || !sha256.test(file.sha256)) refuse('installed-file inventory is invalid.');
    return { path: name, sha256: file.sha256 as string };
  });
  const manifest = payload.manifest as DesktopUpdateManifest;
  if (manifest?.channel !== trust.channel) refuse('release channel does not match.');
  const available = parseDesktopUpdateFeed(manifest, current);
  if (available.availableVersion.includes('-') || available.artifact.fileName !== 'HydraSetup.exe') refuse('stable artifact is invalid.');
  return { ...available, sequence: releaseSequence, payloadSha256, artifactBytes: payload.artifactBytes as number, expectedFiles };
}
