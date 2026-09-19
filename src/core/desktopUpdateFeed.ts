import { createHash } from 'node:crypto';

export const desktopUpdateFeedVersion = 1 as const;

export type DesktopUpdateChannel = 'stable' | 'preview';

export interface DesktopProductIdentity {
  nameShort: 'Hydra';
  applicationName: 'hydra';
  win32AppUserModelId: 'Hydra.IDE';
}

export interface DesktopUpdateCurrent {
  product: DesktopProductIdentity;
  channel: DesktopUpdateChannel;
  version: string;
}

export interface DesktopUpdateArtifact {
  fileName: string;
  sha256: string;
}

/** Claimed signer details are retained for a later native signature verifier. */
export interface DesktopUpdateSignature {
  status: 'valid';
  subject: string;
  thumbprint: string;
  artifactSha256: string;
}

/** Immutable build references, not a download location or an update instruction. */
export interface DesktopUpdateProvenance {
  sourceCommit: string;
  buildRunId: number;
  artifactSha256: string;
}

export interface DesktopUpdateManifest {
  version: 1;
  product: DesktopProductIdentity;
  channel: DesktopUpdateChannel;
  release: {
    version: string;
    artifact: DesktopUpdateArtifact;
    signature: DesktopUpdateSignature;
    provenance: DesktopUpdateProvenance;
  };
  sha256: string;
}

export interface DesktopAvailableUpdate {
  product: DesktopProductIdentity;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  availableVersion: string;
  artifact: DesktopUpdateArtifact;
  signature: DesktopUpdateSignature;
  provenance: DesktopUpdateProvenance;
  manifestSha256: string;
}

const product: DesktopProductIdentity = {
  nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE'
};
const sha256 = /^[a-f0-9]{64}$/;
const thumbprint = /^[A-F0-9]{40}$/;
const commit = /^[a-f0-9]{40}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function fail(message: string): never { throw new Error(`Desktop update feed refused: ${message}`); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))) fail('manifest schema is invalid.');
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, pattern?: RegExp, maximumLength = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength || value.includes('\0') || (pattern && !pattern.test(value))) fail(`${label} is invalid.`);
  return value;
}
function identity(value: unknown): DesktopProductIdentity {
  const item = exact(value, ['nameShort', 'applicationName', 'win32AppUserModelId']);
  if (item.nameShort !== product.nameShort || item.applicationName !== product.applicationName || item.win32AppUserModelId !== product.win32AppUserModelId) fail('product identity does not match Hydra.');
  return product;
}
function channel(value: unknown): DesktopUpdateChannel {
  if (value !== 'stable' && value !== 'preview') fail('channel is invalid.');
  return value;
}
function parseVersion(value: unknown, label: string): string {
  return string(value, label, version, Number.POSITIVE_INFINITY);
}
function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
function compareVersions(left: string, right: string): number {
  const leftMatch = version.exec(left)!;
  const rightMatch = version.exec(right)!;
  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareNumericIdentifiers(leftMatch[index]!, rightMatch[index]!);
    if (comparison) return comparison;
  }
  const leftPre = leftMatch[4], rightPre = rightMatch[4];
  if (!leftPre && !rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  const parts = (item: string) => item.split('.');
  const leftParts = parts(leftPre), rightParts = parts(rightPre);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = leftParts[index], b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a), bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return compareNumericIdentifiers(a, b);
    if (aNumber) return -1;
    if (bNumber) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function parseArtifact(value: unknown): DesktopUpdateArtifact {
  const item = exact(value, ['fileName', 'sha256']);
  const fileName = string(item.fileName, 'artifact file name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(fileName)) fail('artifact file name is invalid.');
  return { fileName, sha256: string(item.sha256, 'artifact SHA-256', sha256) };
}
function parseSignature(value: unknown): DesktopUpdateSignature {
  const item = exact(value, ['status', 'subject', 'thumbprint', 'artifactSha256']);
  if (item.status !== 'valid') fail('signature metadata is unsigned or invalid.');
  return {
    status: 'valid', subject: string(item.subject, 'signature subject'),
    thumbprint: string(item.thumbprint, 'signature thumbprint', thumbprint),
    artifactSha256: string(item.artifactSha256, 'signature artifact SHA-256', sha256)
  };
}
function parseProvenance(value: unknown): DesktopUpdateProvenance {
  const item = exact(value, ['sourceCommit', 'buildRunId', 'artifactSha256']);
  if (!Number.isSafeInteger(item.buildRunId) || (item.buildRunId as number) <= 0) fail('build provenance run ID is invalid.');
  return {
    sourceCommit: string(item.sourceCommit, 'build provenance source commit', commit), buildRunId: item.buildRunId as number,
    artifactSha256: string(item.artifactSha256, 'build provenance artifact SHA-256', sha256)
  };
}

/**
 * Parses an explicitly supplied update record. It does not fetch a feed, verify
 * a certificate, write state, download an artifact, or invoke an updater.
 */
export function parseDesktopUpdateFeed(value: unknown, current: unknown): DesktopAvailableUpdate {
  const installed = exact(current, ['product', 'channel', 'version']);
  const currentProduct = identity(installed.product), currentChannel = channel(installed.channel);
  const currentVersion = parseVersion(installed.version, 'current version');
  const input = exact(value, ['version', 'product', 'channel', 'release', 'sha256']);
  if (input.version !== desktopUpdateFeedVersion) fail('schema version is unsupported.');
  const manifestProduct = identity(input.product), manifestChannel = channel(input.channel);
  if (manifestChannel !== currentChannel) fail('channel crossing is not allowed.');
  const release = exact(input.release, ['version', 'artifact', 'signature', 'provenance']);
  const availableVersion = parseVersion(release.version, 'release version');
  if (compareVersions(availableVersion, currentVersion) <= 0) fail('release version is not newer than the installed version.');
  const artifact = parseArtifact(release.artifact), signature = parseSignature(release.signature), provenance = parseProvenance(release.provenance);
  if (artifact.sha256 !== signature.artifactSha256 || artifact.sha256 !== provenance.artifactSha256) fail('artifact hash does not bind signature and provenance.');
  const manifestSha256 = string(input.sha256, 'manifest SHA-256', sha256);
  const unsigned = { version: desktopUpdateFeedVersion, product: manifestProduct, channel: manifestChannel, release: { version: availableVersion, artifact, signature, provenance } };
  if (digest(unsigned) !== manifestSha256) fail('manifest integrity hash does not match.');
  return { product: currentProduct, channel: currentChannel, currentVersion, availableVersion, artifact, signature, provenance, manifestSha256 };
}
