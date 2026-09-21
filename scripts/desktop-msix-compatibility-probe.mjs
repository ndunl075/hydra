import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.test-build', 'msix-compatibility');
const input = process.argv[2];
if (process.platform !== 'win32' || !input || !path.isAbsolute(input) || process.argv.length !== 3)
  throw new Error('Use on Windows with one absolute path to a built Hydra runtime.');

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  source: input, status: 'started', steps: [], blockers: [] };
const step = (name, details = {}) => { report.steps.push({ name, ...details }); console.log(name); };
await fs.mkdir(scratch, { recursive: true });
const scratchReal = await fs.realpath(scratch);
const run = path.join(scratchReal, `run-${randomUUID()}`);
if (!inside(scratchReal, run)) throw new Error('MSIX probe output escapes scratch directory.');
await fs.mkdir(run);
const writeReport = () => fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');

try {
  const source = await fs.realpath(input);
  const product = JSON.parse(await fs.readFile(path.join(source, 'resources', 'app', 'product.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (product.nameShort !== 'Hydra' || !/^\d+\.\d+\.\d+$/.test(product.hydraVersion))
    throw new Error('Source is not a versioned Hydra desktop runtime.');
  await fs.access(path.join(source, 'Hydra.exe'));
  report.sourceHydraVersion = product.hydraVersion;
  report.expectedHydraVersion = manifest.version;
  report.currentSourceMatch = product.hydraVersion === manifest.version;
  if (!report.currentSourceMatch)
    report.blockers.push('Built runtime version differs from this Hydra source; package is diagnostic only.');

  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const versions = (await fs.readdir(kits)).filter(name => /^10\.0\.\d+\.0$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  let makeAppx;
  for (const version of versions) {
    const candidate = path.join(kits, version, 'x64', 'makeappx.exe');
    try { await fs.access(candidate); makeAppx = candidate; break; } catch { /* try next SDK */ }
  }
  if (!makeAppx) throw new Error('Windows SDK MakeAppx.exe is unavailable.');
  report.makeAppx = makeAppx;
  report.windowsBuild = os.release();

  const stage = path.join(run, 'stage');
  await fs.cp(source, stage, { recursive: true, force: false, errorOnExist: true, dereference: false });
  step('copied disposable Hydra runtime');
  const assets = path.join(stage, 'Assets');
  await fs.mkdir(assets);
  await fs.copyFile(path.join(root, 'hydra-logo.png'), path.join(assets, 'Logo.png'));
  // The hosted acceptance runner may build a second disposable fixture with a
  // higher MSIX version or a different fixture publisher. These are package
  // metadata values only: Hydra's embedded application version remains the
  // version of the copied runtime and is checked independently by the test.
  const packageVersion = process.env.HYDRA_MSIX_FIXTURE_VERSION ?? `${product.hydraVersion}.0`;
  const publisher = process.env.HYDRA_MSIX_FIXTURE_PUBLISHER ?? 'CN=Hydra Fixture';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(packageVersion))
    throw new Error('HYDRA_MSIX_FIXTURE_VERSION must be a four-part numeric MSIX version.');
  if (!/^CN=[A-Za-z0-9 ._-]+$/.test(publisher))
    throw new Error('HYDRA_MSIX_FIXTURE_PUBLISHER must be a simple CN fixture publisher.');
  const packageIdentity = 'NicoDunlap.Hydra.Probe';
  const appxManifest = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${xml(packageIdentity)}" Publisher="${xml(publisher)}" Version="${xml(packageVersion)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Hydra Compatibility Probe</DisplayName>
    <PublisherDisplayName>Hydra Fixture</PublisherDisplayName>
    <Description>Disposable Hydra MSIX compatibility probe</Description>
    <Logo>Assets\\Logo.png</Logo>
    <uap10:PackageIntegrity><uap10:Content Enforcement="on" /></uap10:PackageIntegrity>
  </Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
  <Applications>
    <Application Id="HydraProbe" Executable="Hydra.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="Hydra Compatibility Probe" Description="Disposable Hydra MSIX probe"
        Square150x150Logo="Assets\\Logo.png" Square44x44Logo="Assets\\Logo.png" BackgroundColor="transparent" />
    </Application>
  </Applications>
</Package>
`;
  await fs.writeFile(path.join(stage, 'AppxManifest.xml'), appxManifest);
  step('staged full-trust package manifest', { identity: packageIdentity, publisher, packageVersion,
    packageIntegrity: 'on' });
  const output = path.join(run, `HydraProbe-${packageVersion}.msix`);
  const { stdout, stderr } = await execute(makeAppx, ['pack', '/h', 'SHA256', '/d', stage, '/p', output],
    { cwd: run, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (stderr.trim()) report.makeAppxStderr = stderr.slice(-4000);
  report.makeAppxOutputTail = stdout.slice(-4000);
  report.package = output;
  report.packageBytes = (await fs.stat(output)).size;
  report.blockers.push('Package is unsigned and uninstalled; fixture publisher trust, protected-file behavior, and runtime workflows have not been tested.');
  report.status = 'unsigned-packaged';
  step('created unsigned MSIX package', { packageBytes: report.packageBytes });
  await writeReport();
  console.log(`MSIX diagnostic package created (release gate blocked): ${output}`);
} catch (error) {
  report.status = 'failed';
  report.blockers.push(String(error));
  await writeReport();
  throw error;
}
