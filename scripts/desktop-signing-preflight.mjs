import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const THUMBPRINT = /^[A-F0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`Desktop signing preflight blocked: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function safeRelativePath(value, label) {
  requireString(value, label);
  if (path.isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    fail(`${label} must be a safe relative path.`);
  }
  return value;
}

export function validateManifest(value) {
  const manifest = requireObject(value, 'manifest');
  if (manifest.schemaVersion !== 1) fail('unsupported manifest schema version.');
  const product = requireObject(manifest.product, 'product');
  const name = requireString(product.name, 'product.name');
  const version = requireString(product.version, 'product.version');
  if (!VERSION.test(version)) fail('product.version is invalid.');
  const expectedSigner = requireObject(manifest.expectedSigner, 'expectedSigner');
  const subject = requireString(expectedSigner.subject, 'expectedSigner.subject');
  const thumbprint = requireString(expectedSigner.thumbprint, 'expectedSigner.thumbprint');
  if (!THUMBPRINT.test(thumbprint)) fail('expectedSigner.thumbprint must be 40 uppercase hexadecimal characters.');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) fail('artifacts must contain at least one artifact.');
  const paths = new Set();
  const artifacts = manifest.artifacts.map((entry, index) => {
    const artifact = requireObject(entry, `artifacts[${index}]`);
    const relativePath = safeRelativePath(artifact.path, `artifacts[${index}].path`);
    if (paths.has(relativePath.toLowerCase())) fail(`duplicate artifact path: ${relativePath}.`);
    paths.add(relativePath.toLowerCase());
    if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) fail(`artifacts[${index}].sha256 must be 64 lowercase hexadecimal characters.`);
    if (artifact.product !== name) fail(`artifacts[${index}].product must exactly match product.name.`);
    if (artifact.version !== version) fail(`artifacts[${index}].version must exactly match product.version.`);
    return { path: relativePath, sha256: artifact.sha256, product: artifact.product, version: artifact.version };
  });
  return { schemaVersion: 1, product: { name, version }, expectedSigner: { subject, thumbprint }, artifacts };
}

function underDirectory(base, relativePath) {
  const candidate = path.resolve(base, relativePath);
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`artifact escapes manifest directory: ${relativePath}.`);
  return candidate;
}

export async function inspectWindowsArtifact(file) {
  const command = [
    '$ErrorActionPreference = "Stop"',
    `$artifact = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(file, 'utf16le').toString('base64')}'))`,
    '$item = Get-Item -LiteralPath $artifact',
    '$signature = Get-AuthenticodeSignature -LiteralPath $artifact',
    '[pscustomobject]@{',
    '  status = [string]$signature.Status',
    '  subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }',
    '  thumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { $null }',
    '  productName = [string]$item.VersionInfo.ProductName',
    '  productVersion = [string]$item.VersionInfo.ProductVersion',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  const output = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `PowerShell exited with ${code}.`)));
  });
  try { return JSON.parse(output.trim()); }
  catch { fail(`could not read Windows signature metadata for ${file}.`); }
}

export async function preflight(manifestPath, { readFile = fs.readFile, inspect = inspectWindowsArtifact } = {}) {
  let parsed;
  try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { fail(`manifest is unavailable or invalid JSON: ${manifestPath}.`); }
  const manifest = validateManifest(parsed);
  const base = path.dirname(path.resolve(manifestPath));
  for (const artifact of manifest.artifacts) {
    const file = underDirectory(base, artifact.path);
    let bytes;
    try { bytes = await readFile(file); }
    catch { fail(`artifact is unavailable: ${artifact.path}.`); }
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.sha256) fail(`artifact hash does not match: ${artifact.path}.`);
    let metadata;
    try { metadata = await inspect(file); }
    catch (error) { fail(`could not inspect ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`); }
    if (metadata.status !== 'Valid') fail(`artifact is unsigned, invalid, or untrusted: ${artifact.path} (${metadata.status || 'unknown'}).`);
    if (metadata.productName !== artifact.product || metadata.productVersion !== artifact.version) {
      fail(`artifact product/version does not match: ${artifact.path}.`);
    }
    if (metadata.subject !== manifest.expectedSigner.subject || metadata.thumbprint !== manifest.expectedSigner.thumbprint) {
      fail(`artifact signer does not match the expected signer: ${artifact.path}.`);
    }
  }
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--manifest') throw new Error('Usage: node scripts/desktop-signing-preflight.mjs --manifest path\\to\\desktop-signing.json');
  const manifestPath = path.resolve(argv[1]);
  await preflight(manifestPath);
  console.log(`Desktop signing preflight passed: ${manifestPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
