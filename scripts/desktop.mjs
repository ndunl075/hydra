import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stageWatermarks, verifyWatermarks } from './desktop-watermark.mjs';
const execute = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.desktop');
const source = path.join(cache, 'code-oss');
const output = path.join(cache, 'VSCode-win32-x64');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const pin = await readJson(path.join(root, 'desktop', 'upstream.json'));
const brand = await readJson(path.join(root, 'desktop', 'product.json'));

export function brandedProduct(upstream, version) {
  // Keep upstream MIT notices and shape; replace the application's identity.
  const result = { ...upstream, ...brand, hydraVersion: version };
  delete result.extensionsGallery;
  delete result.updateUrl;
  return result;
}
export function isolatedEditorTypes(upstream, declaration, typeRoots) {
  // A nested checkout otherwise finds Hydra's older @types/vscode through
  // ancestor node_modules, even with typeRoots set. Resolve imports to the
  // editor's own API declarations; keep all upstream checking enabled.
  return { ...upstream, compilerOptions: { ...upstream.compilerOptions,
    typeRoots: upstream.compilerOptions?.typeRoots ?? typeRoots,
    paths: { ...upstream.compilerOptions?.paths, vscode: [declaration] } } };
}
export function brandedInstaller(text) {
  const replacements = new Map([
    ['AppPublisher=Microsoft Corporation', 'AppPublisher=Nico Dunlap'],
    ['AppPublisherURL=https://code.visualstudio.com/', 'AppPublisherURL=https://github.com/ndunl075/hydra'],
    ['AppSupportURL=https://code.visualstudio.com/', 'AppSupportURL=https://github.com/ndunl075/hydra/issues'],
    ['AppUpdatesURL=https://code.visualstudio.com/', 'AppUpdatesURL=https://github.com/ndunl075/hydra/releases'],
    ['OutputBaseFilename=VSCodeSetup', 'OutputBaseFilename=HydraSetup']
  ]);
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2) throw new Error(`Pinned installer changed: ${before}`);
    text = text.replace(before, after);
  }
  if (!/Name: "desktopicon";[^\r\n]*Flags: unchecked/.test(text) || !/Tasks: desktopicon/.test(text)) throw new Error('Installer desktop-shortcut checkbox contract changed.');
  const deleteSection = '[InstallDelete]';
  if (text.split(deleteSection).length !== 2) throw new Error('Pinned installer delete section changed.');
  // Explicitly opting out on reinstall removes the previously installed shortcut.
  // Background updates retain it through the upstream shortcut-update predicate.
  text = text.replace(deleteSection, `${deleteSection}\nType: files; Name: "{autodesktop}\\{#NameLong}.lnk"; Tasks: not desktopicon; Check: ShouldUpdateShortcut(ExpandConstant('{autodesktop}\\{#NameLong}.lnk'))`);
  text = text.replace('If you would like to install VS Code for all users in this system, download the System Installer instead from https://code.visualstudio.com.', 'Hydra currently provides a per-user installer. Restart setup without administrator privileges to install it for your account.');
  return text;
}
export function installerVersionSource(text, version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)) throw new Error('Hydra version is invalid for a Windows installer.');
  const replacements = new Map([
    ['Version: pkg.version,', `Version: ${JSON.stringify(version)},`],
    ["RawVersion: pkg.version.replace(/-\\w+$/, ''),", `RawVersion: ${JSON.stringify(match.slice(1, 4).join('.'))},`]
  ]);
  for (const [before, after] of replacements) {
    if (text.split(before).length !== 2) throw new Error(`Pinned installer version contract changed: ${before}`);
    text = text.replace(before, after);
  }
  return text;
}
async function git(args) { return (await execute('git', args, { cwd: source, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
async function contained(directory) {
  const canonicalRoot = await fs.realpath(root), canonical = await fs.realpath(directory);
  const relative = path.relative(path.join(canonicalRoot, '.desktop'), canonical);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Desktop build directory escapes Hydra workspace.');
  return canonical;
}
async function run(command, args, cwd, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit', env: { ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      npm_config_cache: path.join(cache, 'npm-cache'), npm_config_devdir: path.join(cache, 'node-gyp-cache'), ...extraEnv } });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed: ${code ?? signal}`)));
  });
}
async function npm(args, cwd, extraEnv) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.access(cli);
  await run(process.execPath, [cli, ...args], cwd, extraEnv);
}
export async function prepare() {
  await fs.mkdir(cache, { recursive: true });
  await contained(cache);
  try { await fs.access(source); }
  catch { await run('git', ['clone', '--depth', '1', '--branch', pin.tag, '--single-branch', pin.repository, source], root); }
  await contained(source);
  if (await git(['rev-parse', 'HEAD']) !== pin.commit || await fs.realpath(await git(['rev-parse', '--show-toplevel'])) !== await fs.realpath(source)) throw new Error('Unexpected editor source checkout. Use the exact desktop/upstream.json pin.');
  const manifest = await readJson(path.join(root, 'package.json'));
  const desktopMain = await git(['show', `${pin.commit}:src/vs/workbench/workbench.desktop.main.ts`]);
  const desktopExport = "export { main } from './electron-browser/desktop.main.js';";
  if (desktopMain.split(desktopExport).length !== 2) throw new Error('Pinned desktop entrypoint changed.');
  await fs.copyFile(path.join(root, 'desktop', 'workbench', 'hydraProfile.ts'), path.join(source, 'src', 'vs', 'workbench', 'hydraProfile.ts'));
  await fs.writeFile(path.join(source, 'src', 'vs', 'workbench', 'workbench.desktop.main.ts'), desktopMain.replace(desktopExport, `import './hydraProfile.js';\n\n${desktopExport}`));
  for (const [configPath, declaration, typeRoots] of [
    ['src/tsconfig.base.json', './vscode-dts/vscode.d.ts', ['../node_modules/@types']],
    ['extensions/tsconfig.base.json', '../src/vscode-dts/vscode.d.ts', ['./node_modules/@types', '../node_modules/@types']]
  ]) {
    const config = JSON.parse(await git(['show', `${pin.commit}:${configPath}`]));
    await fs.writeFile(path.join(source, configPath), JSON.stringify(isolatedEditorTypes(config, declaration, typeRoots), null, 2) + '\n');
  }
  const original = JSON.parse(await git(['show', `${pin.commit}:product.json`]));
  await fs.writeFile(path.join(source, 'product.json'), JSON.stringify(brandedProduct(original, manifest.version), null, 2) + '\n');
  const installer = await git(['show', `${pin.commit}:build/win32/code.iss`]);
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(installer));
  const electron = await git(['show', `${pin.commit}:build/lib/electron.ts`]);
  if (!electron.includes("companyName: 'Microsoft Corporation'")) throw new Error('Pinned executable publisher metadata changed.');
  await fs.writeFile(path.join(source, 'build', 'lib', 'electron.ts'), electron.replace("companyName: 'Microsoft Corporation'", "companyName: 'Nico Dunlap'"));
  await stageWatermarks(path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media'), await fs.readFile(path.join(root, 'hydra-logo.png')));
  console.log(`Prepared Hydra ${manifest.version}: Code - OSS ${pin.tag} at ${pin.commit}.`);
}
export async function stageHydra(destination) {
  const manifest = await readJson(path.join(root, 'package.json'));
  manifest.contributes.configurationDefaults = { ...manifest.contributes.configurationDefaults, 'workbench.colorTheme': 'Hydra Dark' };
  await fs.mkdir(destination, { recursive: true });
  for (const name of ['dist', 'themes', 'media', 'README.md', 'hydra-logo.png']) await fs.cp(path.join(root, name), path.join(destination, name), { recursive: true });
  // Smoke-test code is a development artifact, not a bundled extension entrypoint.
  await fs.rm(path.join(destination, 'dist', 'smoke.cjs'), { force: true });
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}
export async function verify() {
  await contained(output);
  const exe = await fs.readFile(path.join(output, 'Hydra.exe'));
  if (exe.subarray(0, 2).toString() !== 'MZ') throw new Error('Hydra Windows executable is missing or invalid.');
  const product = await readJson(path.join(output, 'resources', 'app', 'product.json'));
  if (product.nameShort !== 'Hydra' || product.dataFolderName !== '.hydra' || product.win32AppUserModelId !== 'Hydra.IDE' || product.extensionsGallery) throw new Error('Desktop identity/profile isolation failed.');
  const bundled = path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager');
  const manifest = await readJson(path.join(bundled, 'package.json'));
  if (manifest.publisher !== 'nico-dunlap' || manifest.name !== 'hydra-agent-manager') throw new Error('Built-in Hydra extension is missing.');
  await fs.access(path.join(bundled, 'dist', 'extension.cjs'));
  await fs.access(path.join(bundled, 'themes', 'hydra-light.json'));
  await verifyWatermarks(path.join(output, 'resources', 'app', 'out', 'media'), await fs.readFile(path.join(root, 'hydra-logo.png')));
  console.log(`Verified standalone executable and built-in Hydra ${manifest.version}: ${output}`);
}
export async function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('First desktop target is native Windows x64.');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 22 || minor === 22 && patch < 1) throw new Error(`Code - OSS requires Node ${pin.node}+ in major 22. Use a workspace-local toolchain; do not bypass its version check.`);
  await prepare();
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-icons.ps1'), '-LogoPath', path.join(root, 'hydra-logo.png'), '-ResourceDirectory', path.join(source, 'resources', 'win32')], root);
  await npm(['run', 'build'], root);
  await npm(['ci'], source);
  await npm(['run', 'gulp', '--', 'vscode-win32-x64'], source);
  await contained(output);
  await stageHydra(path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager'));
  await verify();
}
export async function smoke() {
  await verify();
  await npm(['run', 'test:smoke'], root, { HYDRA_TEST_DESKTOP: path.join(output, 'Hydra.exe') });
}
export async function installer() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Installer generation requires native Windows x64.');
  await verify();
  await contained(source);
  if (await git(['rev-parse', 'HEAD']) !== pin.commit) throw new Error('Installer requires the pinned editor checkout.');
  const manifest = await readJson(path.join(root, 'package.json'));
  const product = await readJson(path.join(output, 'resources', 'app', 'product.json'));
  const bundled = await readJson(path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager', 'package.json'));
  if (product.hydraVersion !== manifest.version || bundled.version !== manifest.version) throw new Error('Build the current Hydra runtime before packaging its installer.');
  const sourcePath = 'build/gulpfile.vscode.win32.ts';
  await fs.writeFile(path.join(source, sourcePath), installerVersionSource(await git(['show', `${pin.commit}:${sourcePath}`]), manifest.version));
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(await git(['show', `${pin.commit}:build/win32/code.iss`])));
  // The standalone app task does not stage installer-specific updater tools.
  // Use the pinned task, including Hydra's icon, before compiling [Files].
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-inno-updater'], source);
  for (const name of ['inno_updater.exe','vcruntime140.dll']) {
    const tool=await fs.readFile(path.join(output,'tools',name));
    if(tool.length<1024||tool.subarray(0,2).toString()!=='MZ')throw new Error(`Required installer tool is missing or invalid: ${name}`);
  }
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-user-setup'], source);
  const setup = path.join(source, '.build', 'win32-x64', 'user-setup', 'HydraSetup.exe');
  const bytes = await fs.readFile(setup);
  if (bytes.length < 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Installer executable is missing or invalid.');
  console.log(`Generated unsigned Hydra ${manifest.version} user installer: ${setup}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const commands = { prepare, build, verify, smoke, installer };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Use desktop.mjs prepare, build, verify, smoke, or installer.');
  await command();
}
