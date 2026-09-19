import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_LOGS = [
  'shortcut-selected-prior.log',
  'shortcut-selected-upgrade.log',
  'shortcut-unselected-prior.log',
  'shortcut-unselected-upgrade.log'
];

function fail(message) { throw new Error(`Desktop upgrade evidence blocked: ${message}`); }

async function readJson(file, label) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch { fail(`${label} is unavailable: ${file}.`); }
  try { return JSON.parse(text); }
  catch { fail(`${label} is not valid JSON.`); }
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is missing.`);
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function sameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

async function sha256(file, label = 'current installer') {
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch { fail(`${label} is unavailable: ${file}.`); }
  return createHash('sha256').update(bytes).digest('hex');
}

function validateBaseline(value, now) {
  const baseline = requireObject(value, 'pinned baseline');
  requireString(baseline.version, 'pinned baseline version', VERSION);
  requireString(baseline.headSha, 'pinned baseline head SHA', /^[a-f0-9]{40}$/i);
  if (!Number.isSafeInteger(baseline.runId) || baseline.runId <= 0) fail('pinned baseline run ID is invalid.');
  if (!Number.isSafeInteger(baseline.artifactId) || baseline.artifactId <= 0) fail('pinned baseline artifact ID is invalid.');
  requireString(baseline.artifactName, 'pinned baseline artifact name', /\S/);
  requireString(baseline.artifactDigest, 'pinned baseline artifact digest', /^sha256:[a-f0-9]{64}$/i);
  requireString(baseline.installerSha256, 'pinned baseline installer SHA-256', SHA256);
  if (typeof baseline.expiresAt !== 'string') fail('pinned baseline expiry is missing.');
  const expiresAt = new Date(baseline.expiresAt);
  if (Number.isNaN(expiresAt.valueOf())) fail('pinned baseline expiry is invalid.');
  if (expiresAt.valueOf() <= now.valueOf()) fail('pinned baseline has expired.');
  return baseline;
}

function validateProvenance(value, baseline, version, currentHash) {
  const provenance = requireObject(value, 'PowerShell provenance');
  const prior = requireObject(provenance.prior, 'PowerShell provenance prior baseline');
  for (const key of ['version', 'headSha', 'runId', 'artifactId', 'artifactName', 'artifactDigest', 'installerSha256', 'expiresAt']) {
    if (prior[key] !== baseline[key]) fail(`PowerShell provenance prior ${key} does not match the pinned baseline.`);
  }
  if (provenance.currentVersion !== version) fail('PowerShell provenance current version does not match package.json.');
  if (!sameHash(provenance.currentInstallerSha256, currentHash)) fail('PowerShell provenance current installer hash does not match the selected artifact.');
  if (!Array.isArray(provenance.runtimeCompared) || provenance.runtimeCompared.length === 0) fail('PowerShell provenance has no runtime comparison.');
}

async function assertCycles(logsDirectory) {
  if (!logsDirectory) fail('PowerShell log directory is required to prove shortcut cycles.');
  for (const name of REQUIRED_LOGS) {
    try {
      const stat = await fs.stat(path.join(logsDirectory, name));
      if (!stat.isFile()) fail(`shortcut cycle log is not a file: ${name}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Desktop upgrade evidence blocked:')) throw error;
      fail(`shortcut cycle is missing: ${name}.`);
    }
  }
}

function validateTranscript(text, baselineVersion, version) {
  const match = /PASS:\s*pinned Hydra\s+([^\s]+)\s+upgrades to\s+([^,\s]+)/i.exec(text);
  if (!match) fail('PowerShell output does not contain a passing distinct-version upgrade result.');
  if (match[1] !== baselineVersion || match[2] !== version) fail('PowerShell output version does not match pinned/current versions.');
  if (!/selected\/unselected shortcut preference/i.test(text)) fail('PowerShell output does not claim selected and unselected shortcut preservation.');
}

/**
 * Validate records copied from a disposable Windows run. This parser is deliberately
 * incapable of accepting that run: a release owner must still accept the hosted run.
 */
export async function parseDesktopUpgradeEvidence(options) {
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.valueOf())) fail('current time is invalid.');
  const baseline = validateBaseline(await readJson(options.baselinePath, 'pinned baseline'), now);
  const manifest = requireObject(await readJson(options.manifestPath, 'package manifest'), 'package manifest');
  const version = requireString(manifest.version, 'package manifest version', VERSION);
  if (version === baseline.version) fail('current Hydra version must differ from the pinned baseline version.');
  const currentHash = await sha256(options.currentInstallerPath);
  const priorHash = await sha256(options.priorInstallerPath, 'pinned prior installer');
  if (!sameHash(priorHash, baseline.installerSha256)) fail('pinned prior installer hash does not match the pinned baseline.');
  const provenance = await readJson(options.provenancePath, 'PowerShell provenance');
  validateProvenance(provenance, baseline, version, currentHash);
  let transcript;
  try { transcript = await fs.readFile(options.outputPath, 'utf8'); }
  catch { fail(`PowerShell output is unavailable: ${options.outputPath}.`); }
  validateTranscript(transcript, baseline.version, version);
  await assertCycles(options.logsDirectory);
  return {
    schemaVersion: 1,
    kind: 'desktop-distinct-version-upgrade-provenance',
    priorVersion: baseline.version,
    currentVersion: version,
    baseline: {
      headSha: baseline.headSha,
      runId: baseline.runId,
      artifactId: baseline.artifactId,
      artifactName: baseline.artifactName,
      artifactDigest: baseline.artifactDigest,
      installerSha256: baseline.installerSha256,
      expiresAt: baseline.expiresAt
    },
    currentInstallerSha256: currentHash,
    shortcutCycles: { selected: 'recorded', unselected: 'recorded' },
    localParser: { status: 'consistent', acceptance: 'pending-disposable-windows-run' }
  };
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) fail('arguments must be --name value pairs.');
    values[key.slice(2)] = value;
  }
  for (const name of ['baseline', 'manifest', 'provenance', 'output', 'logs-dir', 'current-installer', 'prior-installer']) {
    if (!values[name]) fail(`--${name} is required.`);
  }
  return {
    baselinePath: values.baseline,
    manifestPath: values.manifest,
    provenancePath: values.provenance,
    outputPath: values.output,
    logsDirectory: values['logs-dir'],
    currentInstallerPath: values['current-installer'],
    priorInstallerPath: values['prior-installer'],
    now: values.now
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.stdout.write(`${JSON.stringify(await parseDesktopUpgradeEvidence(argumentsFrom(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
