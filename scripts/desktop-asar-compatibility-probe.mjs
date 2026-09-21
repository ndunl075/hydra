import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPackageWithOptions, getRawHeader } from '@electron/asar';
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { NtExecutable, NtExecutableResource } from 'resedit';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(repository, '.test-build', 'asar-compatibility');
const source = process.argv[2];
const experimentalFs = process.argv[3] === '--experimental-electron-fs';
if (process.platform !== 'win32' || !source || !path.isAbsolute(source) ||
    process.argv.length !== (experimentalFs ? 4 : 3))
  throw new Error('Use on Windows with an absolute built runtime path and optional --experimental-electron-fs.');

const report = { schemaVersion: 1, source, generatedAt: new Date().toISOString(),
  status: 'started', experimentalElectronFs: experimentalFs, steps: [], blockers: [] };
const writeReport = async directory => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const step = (name, details = {}) => { report.steps.push({ name, ...details }); console.log(name); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

await fs.mkdir(scratch, { recursive: true });
const scratchReal = await fs.realpath(scratch);
const run = path.join(scratchReal, `run-${randomUUID()}`);
if (!within(scratchReal, run)) throw new Error('Probe output escapes scratch directory.');
await fs.mkdir(run, { recursive: false });
const output = path.join(run, 'runtime');
report.output = output;
try {
  const original = await fs.realpath(source);
  const sourceApp = path.join(original, 'resources', 'app');
  const product = JSON.parse(await fs.readFile(path.join(sourceApp, 'product.json'), 'utf8'));
  const expectedVersion = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
  report.sourceHydraVersion = product.hydraVersion;
  report.expectedHydraVersion = expectedVersion;
  report.currentSourceMatch = product.hydraVersion === expectedVersion;
  if (!report.currentSourceMatch) report.blockers.push('Built runtime version differs from this Hydra source; compatibility result is diagnostic only.');
  await fs.access(path.join(original, 'Hydra.exe'));
  await fs.access(path.join(sourceApp, 'out', 'main.js'));
  await fs.cp(original, output, { recursive: true, force: false, errorOnExist: true, dereference: false });
  step('copied disposable runtime', { sourceHydraVersion: product.hydraVersion });

  const resources = path.join(output, 'resources');
  const app = path.join(resources, 'app');
  if (experimentalFs) {
    for (const name of ['main.js', 'bootstrap-fork.js', 'cli.js']) {
      const file = path.join(app, 'out', name);
      const before = await fs.readFile(file, 'utf8');
      const needle = "url: 'node:original-fs'";
      if (before.split(needle).length !== 2)
        throw new Error(`Pinned ${name} fs loader contract changed.`);
      await fs.writeFile(file, before.replace(needle, "url: 'node:fs'"));
    }
    step('replaced packaged fs loader hooks in disposable copy');
  }
  const legacy = path.join(app, 'node_modules.asar');
  const legacyHeader = getRawHeader(legacy).header;
  if (Object.keys(legacyHeader.files ?? {}).length !== 0) throw new Error('Nonempty legacy node_modules.asar requires normalization before this probe.');
  await fs.rm(legacy);
  step('removed empty legacy dependency archive');

  const archive = path.join(resources, 'app.asar');
  // @electron/asar matches the absolute filename with matchBase on Windows.
  // A path-prefixed glob would silently leave native binaries inside ASAR.
  await createPackageWithOptions(app, archive, { dot: true, unpack: '*.{node,dll,exe,cmd}' });
  const raw = getRawHeader(archive);
  const main = raw.header.files?.out?.files?.['main.js'];
  if (!main?.integrity?.hash || main.unpacked) throw new Error('Main entrypoint is not integrity-covered in app.asar.');
  const nativeFiles = [];
  const inspect = (directory, relative = '') => {
    for (const [name, entry] of Object.entries(directory.files ?? {})) {
      const child = relative ? path.join(relative, name) : name;
      if (entry.files) inspect(entry, child);
      else if (/\.(node|dll|exe|cmd)$/i.test(name)) nativeFiles.push({ path: child, unpacked: !!entry.unpacked });
    }
  };
  inspect(raw.header);
  if (!nativeFiles.length || nativeFiles.some(file => !file.unpacked))
    throw new Error('Native executable files were silently packed into app.asar.');
  for (const file of nativeFiles)
    await fs.access(path.join(resources, 'app.asar.unpacked', file.path));
  const headerHash = digest(Buffer.from(raw.headerString, 'utf8'));
  step('created application archive', { archiveBytes: (await fs.stat(archive)).size,
    headerSha256: headerHash, mainIntegrity: main.integrity,
    unpackedNativeFiles: nativeFiles.map(file => file.path) });

  const exePath = path.join(output, 'Hydra.exe');
  const exe = NtExecutable.from(await fs.readFile(exePath));
  const resourcesPe = NtExecutableResource.from(exe);
  if (resourcesPe.entries.some(entry => String(entry.type).toUpperCase() === 'INTEGRITY'))
    throw new Error('Copied executable already has an integrity resource.');
  const integrity = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'sha256', value: headerHash }]), 'utf8');
  const language = resourcesPe.entries[0];
  resourcesPe.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR',
    bin: integrity.buffer.slice(integrity.byteOffset, integrity.byteOffset + integrity.byteLength),
    lang: language?.lang ?? 0, codepage: language?.codepage ?? 1252 });
  resourcesPe.outputResource(exe);
  await fs.writeFile(exePath, Buffer.from(exe.generate()));
  step('embedded Windows archive-integrity resource');

  await flipFuses(exePath, { version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true });
  const wire = await getCurrentFuseWire(exePath);
  if (wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== 49 ||
      wire[FuseV1Options.OnlyLoadAppFromAsar] !== 49) throw new Error('Required Electron fuses did not remain enabled.');
  const finalPe = NtExecutableResource.from(NtExecutable.from(await fs.readFile(exePath)));
  const embedded = finalPe.entries.find(entry => String(entry.type).toUpperCase() === 'INTEGRITY' &&
    String(entry.id).toUpperCase() === 'ELECTRONASAR');
  if (!embedded || Buffer.from(embedded.bin).toString('utf8') !== integrity.toString('utf8'))
    throw new Error('Final executable integrity resource differs from archive header.');
  step('verified fuses and embedded resource');

  const appReal = await fs.realpath(app);
  const outputReal = await fs.realpath(output);
  if (!within(outputReal, appReal) || appReal !== path.join(outputReal, 'resources', 'app'))
    throw new Error('Loose application directory is outside the disposable runtime.');
  await fs.rm(appReal, { recursive: true });
  step('removed loose application fallback');
  // The normal original-fs hook cannot scan packed built-ins. The optional
  // node:fs substitution is a compatibility experiment, not fail-closed
  // code-load proof; a tampered built-in logged a mismatch and still reached
  // extension activation in the disposable old-version runtime.
  report.blockers.push(experimentalFs
    ? 'Experimental global fs hook substitution changes workspace ASAR handling; in a disposable runtime, altered packed Hydra code reached activation after an integrity-mismatch log, so fail-closed code loading is unproven.'
    : 'Code OSS original-fs cannot scan built-in extensions in app.asar; a loose --builtin-extensions-dir override is not an integrity-preserving release fix.');
  report.blockers.push('Unpacked native binaries and scripts are outside Electron ASAR integrity and need a separate code-load trust boundary.');
  report.status = 'diagnostic-blocked';
  await writeReport(run);
  console.log(`ASAR diagnostic package created (release gate blocked): ${output}`);
} catch (error) {
  report.status = 'failed';
  report.blockers.push(String(error));
  await writeReport(run);
  throw error;
}
