import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const maxFiles = 20000;
const maxManifestBytes = 4 * 1024 * 1024;
const maxFileBytes = 1024 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Exact pinned Inno [Files] contract for Hydra's unversioned x64 user setup.
// If upstream changes a mapping, review this inventory before compiling it.
export const innoFilesContract = String.raw`[Files]
Source: "*"; Excludes: "\CodeSignSummary*.md,\tools,\tools\*,\policies,\policies\*,\appx,\appx\*,\resources\app\product.json,\{#ExeBasename}.exe,{#ifdef ProxyExeBasename}\{#ProxyExeBasename}.exe,{#endif}\{#ExeBasename}.VisualElementsManifest.xml,\bin,\bin\*"; DestDir: "{code:GetDestDir}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ExeBasename}.exe"; DestDir: "{code:GetDestDir}"; DestName: "{code:GetExeBasename}"; Flags: ignoreversion
Source: "{#ExeBasename}.VisualElementsManifest.xml"; DestDir: "{code:GetDestDir}"; DestName: "{code:GetVisualElementsManifest}"; Flags: ignoreversion
#ifdef ProxyExeBasename
Source: "{#ProxyExeBasename}.exe"; DestDir: "{code:GetDestDir}"; DestName: "{code:GetProxyExeBasename}"; Flags: ignoreversion
#endif
Source: "tools\*"; DestDir: "{app}\{#VersionedResourcesFolder}\tools"; Flags: ignoreversion
Source: "policies\*"; DestDir: "{code:GetDestDir}\{#VersionedResourcesFolder}\policies"; Flags: ignoreversion skipifsourcedoesntexist
Source: "bin\{#TunnelApplicationName}.exe"; DestDir: "{code:GetDestDir}\bin"; DestName: "{code:GetBinDirTunnelApplicationFilename}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "bin\{#ApplicationName}.cmd"; DestDir: "{code:GetDestDir}\bin"; DestName: "{code:GetBinDirApplicationCmdFilename}"; Flags: ignoreversion
Source: "bin\{#ApplicationName}"; DestDir: "{code:GetDestDir}\bin"; DestName: "{code:GetBinDirApplicationFilename}"; Flags: ignoreversion
Source: "{#ProductJsonPath}"; DestDir: "{code:GetDestDir}\{#VersionedResourcesFolder}\resources\app"; Flags: ignoreversion
#ifdef AppxPackageName
Source: "appx\{#AppxPackage}"; DestDir: "{code:GetDestDir}\{#VersionedResourcesFolder}\appx"; BeforeInstall: RemoveAppxPackage; Flags: ignoreversion; Check: ShouldUseWindows11ContextMenu
Source: "appx\{#AppxPackageDll}"; DestDir: "{code:GetDestDir}\{#VersionedResourcesFolder}\appx"; AfterInstall: AddAppxPackage; Flags: ignoreversion; Check: ShouldUseWindows11ContextMenu
#endif`;

function refuse(reason) { throw new Error(`Installed inventory refused: ${reason}`); }
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
}
function ordinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function safeSegment(segment) {
  if (!segment || segment === '.' || segment === '..' || segment.length > 255 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) refuse('unsafe Windows destination path.');
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\')) refuse('destination path is invalid.');
  value.split('/').forEach(safeSegment);
  return value;
}
export function assertPinnedInnoFiles(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.indexOf('[Files]\n');
  const end = normalized.indexOf('\n[', start + 1);
  if (start < 0 || end < 0 || normalized.indexOf('[Files]\n', start + 1) >= 0 ||
      normalized.slice(start, end).trimEnd() !== innoFilesContract) refuse('pinned Inno file mapping changed.');
}
function strictProduct(product, version) {
  if (!product || product.nameShort !== 'Hydra' || product.applicationName !== 'hydra' ||
      product.tunnelApplicationName !== 'hydra-tunnel' || product.hydraVersion !== version ||
      product.target !== 'user' || product.win32VersionedUpdate || product.embedded ||
      (product.quality && product.quality !== 'dev')) refuse('unsupported installer target or product layout.');
}
async function requireDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('source directory is reparsed or missing.');
}
async function hashFile(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(maxFileBytes)) refuse('payload file type, link count, or size is invalid.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size) refuse('payload file changed during open.');
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(block, 0, Math.min(block.length, Number(before.size) - position), position);
      if (!bytesRead) refuse('payload file was truncated during hashing.');
      hash.update(block.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      refuse('payload file changed during hashing.');
    return { bytes: position, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
async function enumerate(directory, prefix = '') {
  await requireDirectory(directory);
  const result = [];
  for (const name of (await fs.readdir(directory)).sort(ordinal)) {
    safeSegment(name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink()) refuse('reparsed payload path.');
    if (info.isDirectory()) result.push(...await enumerate(absolute, relative));
    else if (info.isFile()) result.push({ path: relative, absolute });
    else refuse('unsupported payload filesystem object.');
    if (result.length > maxFiles) refuse('too many payload files.');
  }
  return result;
}
function validateProvenance(options) {
  if (typeof options.version !== 'string' || !versionPattern.test(options.version) ||
      typeof options.sourceCommit !== 'string' || !commit.test(options.sourceCommit) ||
      typeof options.upstreamCommit !== 'string' || !commit.test(options.upstreamCommit))
    refuse('release provenance is invalid.');
}
export async function createInstalledInventory(options) {
  validateProvenance(options);
  assertPinnedInnoFiles(await fs.readFile(options.innoSource, 'utf8'));
  const product = JSON.parse(await fs.readFile(options.stagedProductPath, 'utf8'));
  strictProduct(product, options.version);
  const source = await enumerate(options.sourceDirectory);
  if (new Set(source.map(item => item.path.toLowerCase())).size !== source.length)
    refuse('case-colliding installer source paths.');
  const bySource = new Map(source.map(item => [item.path.toLowerCase(), item]));
  const take = (name, required = true) => {
    const item = bySource.get(name.toLowerCase());
    if (!item && required) refuse(`required installer input is missing: ${name}`);
    return item;
  };
  const mapped = [];
  for (const item of source) {
    const first = item.path.split('/')[0].toLowerCase();
    if (['tools', 'policies', 'bin', 'appx'].includes(first) ||
        item.path.toLowerCase() === 'resources/app/product.json' ||
        ['hydra.exe', 'hydra.visualelementsmanifest.xml'].includes(item.path.toLowerCase()) ||
        (!item.path.includes('/') && /^codesignsummary.*\.md$/i.test(item.path))) continue;
    mapped.push(item);
  }
  for (const name of ['Hydra.exe', 'Hydra.VisualElementsManifest.xml']) mapped.push(take(name));
  for (const name of ['hydra', 'hydra.cmd']) mapped.push(take(`bin/${name}`));
  const tunnel = take('bin/hydra-tunnel.exe', false);
  if (tunnel) mapped.push(tunnel);
  for (const directory of ['tools', 'policies']) {
    for (const item of source.filter(item => item.path.toLowerCase().startsWith(`${directory}/`))) {
      if (item.path.slice(directory.length + 1).includes('/')) refuse('unsupported nested installer tool or policy.');
      mapped.push(item);
    }
  }
  for (const name of ['HydraUpdateVerify.exe', 'inno_updater.exe', 'vcruntime140.dll']) take(`tools/${name}`);
  if (source.some(item => item.path.toLowerCase().startsWith('appx/')) ||
      source.some(item => item.path.toLowerCase().startsWith('bin/') &&
        !['bin/hydra', 'bin/hydra.cmd', 'bin/hydra-tunnel.exe'].includes(item.path.toLowerCase())))
    refuse('unsupported Appx or bin installer input.');
  mapped.push({ path: 'resources/app/product.json', absolute: options.stagedProductPath });
  const destinations = new Set();
  const files = [];
  for (const item of mapped) {
    const destination = safeRelative(item.path);
    const folded = destination.toLowerCase();
    if (destinations.has(folded)) refuse('duplicate Windows installer destination.');
    destinations.add(folded);
    files.push({ path: destination, ...await hashFile(item.absolute) });
  }
  files.sort((left, right) => ordinal(left.path, right.path));
  if (!files.length || files.length > maxFiles) refuse('payload count is invalid.');
  const inventory = { schemaVersion: 1, purpose: 'hydra-installed-code-inventory', product: 'Hydra',
    version: options.version, target: { platform: 'win32', architecture: 'x64', installTarget: 'user' },
    layout: 'inno-user-unversioned-v1', sourceCommit: options.sourceCommit,
    upstreamCommit: options.upstreamCommit, files };
  if (Buffer.byteLength(JSON.stringify(inventory)) > maxManifestBytes) refuse('inventory document is too large.');
  return inventory;
}
export function parseInstalledInventory(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxManifestBytes) refuse('inventory size is invalid.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return refuse('inventory JSON is invalid.'); }
  if (JSON.stringify(value) !== bytes.toString('utf8') ||
      !exact(value, ['schemaVersion', 'purpose', 'product', 'version', 'target', 'layout', 'sourceCommit', 'upstreamCommit', 'files']) ||
      value.schemaVersion !== 1 || value.purpose !== 'hydra-installed-code-inventory' || value.product !== 'Hydra' ||
      value.layout !== 'inno-user-unversioned-v1' ||
      !exact(value.target, ['platform', 'architecture', 'installTarget']) || value.target.platform !== 'win32' ||
      value.target.architecture !== 'x64' || value.target.installTarget !== 'user' ||
      typeof value.version !== 'string' || !versionPattern.test(value.version) ||
      typeof value.sourceCommit !== 'string' || !commit.test(value.sourceCommit) ||
      typeof value.upstreamCommit !== 'string' || !commit.test(value.upstreamCommit) ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > maxFiles) refuse('inventory schema is invalid.');
  let previous = '';
  const folded = new Set();
  for (const file of value.files) {
    if (!exact(file, ['path', 'bytes', 'sha256']) || safeRelative(file.path) <= previous ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maxFileBytes ||
        typeof file.sha256 !== 'string' || !digest.test(file.sha256) || folded.has(file.path.toLowerCase()))
      refuse('inventory file entry is invalid.');
    previous = file.path;
    folded.add(file.path.toLowerCase());
  }
  return value;
}
export async function compareInventoryToInputs(bytes, options) {
  const saved = parseInstalledInventory(bytes);
  const current = await createInstalledInventory(options);
  if (JSON.stringify(saved) !== JSON.stringify(current)) refuse('installer inputs differ from saved inventory.');
  return saved;
}
export async function compareInventoryToTree(bytes, directory) {
  const saved = parseInstalledInventory(bytes);
  const actual = (await enumerate(directory)).sort((left, right) => ordinal(left.path, right.path));
  if (actual.length !== saved.files.length) refuse('installed payload file count differs.');
  for (let index = 0; index < actual.length; index++) {
    const item = actual[index];
    const expected = saved.files[index];
    if (item.path !== expected.path) refuse('installed payload path differs.');
    const observed = await hashFile(item.absolute);
    if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) refuse('installed payload bytes differ.');
  }
  return saved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...raw] = process.argv.slice(2);
  if (!['generate', 'verify-inputs', 'verify-tree'].includes(command) || raw.length % 2) refuse('inventory command is invalid.');
  const args = Object.fromEntries(Array.from({ length: raw.length / 2 }, (_, index) => [raw[index * 2], raw[index * 2 + 1]]));
  if (Object.keys(args).length !== raw.length / 2) refuse('duplicate inventory option.');
  const outputPath = args['--inventory'];
  if (!outputPath || !path.isAbsolute(outputPath)) refuse('inventory path is invalid.');
  if (command === 'verify-tree') {
    if (Object.keys(args).sort().join(',') !== ['--inventory', '--tree'].sort().join(',') || !path.isAbsolute(args['--tree'])) refuse('tree options are invalid.');
    await compareInventoryToTree(await fs.readFile(outputPath), args['--tree']);
  } else {
    const required = ['--inventory', '--source', '--product', '--inno', '--version', '--source-commit', '--upstream-commit'];
    if (Object.keys(args).sort().join(',') !== required.sort().join(',') ||
        ![args['--source'], args['--product'], args['--inno']].every(path.isAbsolute)) refuse('inventory options are invalid.');
    const options = { sourceDirectory: args['--source'], stagedProductPath: args['--product'], innoSource: args['--inno'],
      version: args['--version'], sourceCommit: args['--source-commit'], upstreamCommit: args['--upstream-commit'] };
    if (command === 'generate') {
      const inventory = await createInstalledInventory(options);
      await fs.writeFile(outputPath, JSON.stringify(inventory), { flag: 'wx' });
    } else await compareInventoryToInputs(await fs.readFile(outputPath), options);
  }
  console.log(`Verified unsigned installer payload inventory: ${outputPath}`);
}
