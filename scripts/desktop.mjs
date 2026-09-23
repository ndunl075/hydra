import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { stageWatermarks, verifyWatermarks } from './desktop-watermark.mjs';
const execute = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.desktop');
const source = path.join(cache, 'code-oss');
const output = path.join(cache, 'VSCode-win32-x64');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const pin = await readJson(path.join(root, 'desktop', 'upstream.json'));
const brand = await readJson(path.join(root, 'desktop', 'product.json'));

export function installedUpdateTrust(value) {
  const refuse = () => { throw new Error('Installed desktop update trust configuration is invalid.'); };
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.getPrototypeOf(object) === Object.prototype && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  const base = ['schemaVersion', 'status', 'product', 'channel', 'target'];
  if (!exact(value, value?.status === 'disabled' ? base : [...base, 'origin', 'keyId', 'publicKeyPem', 'authenticodeSigners'])) refuse();
  if (value.schemaVersion !== 1 || value.product !== 'Hydra' || value.channel !== 'stable' || !exact(value.target, ['platform', 'architecture', 'installTarget']) || value.target.platform !== 'win32' || value.target.architecture !== 'x64' || value.target.installTarget !== 'user') refuse();
  if (value.status === 'disabled') return value;
  if (value.status !== 'enabled') refuse();
  if (typeof value.origin !== 'string' || value.origin.length > 255) refuse();
  let origin;
  try { origin = new URL(value.origin); } catch { refuse(); }
  if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || isIP(origin.hostname) || !origin.hostname.includes('.') || origin.hostname.endsWith('.localhost')) refuse();
  if (typeof value.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.keyId) || typeof value.publicKeyPem !== 'string' || value.publicKeyPem.length > 4096) refuse();
  try {
    const key = createPublicKey(value.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }) !== value.publicKeyPem) refuse();
  } catch { refuse(); }
  if (!Array.isArray(value.authenticodeSigners) || value.authenticodeSigners.length < 1 || value.authenticodeSigners.length > 3 || value.authenticodeSigners.some(signer => !exact(signer, ['subject', 'thumbprint']) || typeof signer.subject !== 'string' || signer.subject.length < 3 || signer.subject.length > 512 || signer.subject.trim() !== signer.subject || /[\x00-\x1f]/.test(signer.subject) || typeof signer.thumbprint !== 'string' || !/^[A-F0-9]{40}$/.test(signer.thumbprint)) || new Set(value.authenticodeSigners.map(signer => signer.thumbprint)).size !== value.authenticodeSigners.length) refuse();
  return value;
}

export function brandedProduct(upstream, version) {
  // Keep upstream MIT notices and shape; replace the application's identity.
  installedUpdateTrust(brand.hydraUpdateTrust);
  const result = { ...upstream, ...brand, hydraVersion: version };
  delete result.extensionsGallery;
  delete result.updateUrl;
  return result;
}
export function brandedElectronMain(text) {
  if (text.includes('initializeHydraUpdateTrust')) throw new Error('Pinned Electron main changed: Hydra trust hook already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned Electron main changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce("import { CodeApplication } from './app.js';",
    "import { CodeApplication } from './app.js';\nimport { initializeHydraUpdateTrust } from './hydraUpdateTrust.js';");
  replaceOnce('await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);',
    'await this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);\n\t\t\t\ttry { initializeHydraUpdateTrust(productService); } catch { console.error("Hydra updates disabled: invalid installed trust."); }');
  return text;
}
export function brandedElectronApp(text) {
  if (text.includes('HydraUpdateService')) throw new Error('Pinned Electron app changed: Hydra update service already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned Electron app changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce("import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';",
    "import { HydraUpdateService } from './hydraUpdateService.js';");
  replaceOnce('services.set(IUpdateService, new SyncDescriptor(Win32UpdateService));',
    'services.set(IUpdateService, new SyncDescriptor(HydraUpdateService));');
  return text;
}
export const hydraMainUpdateModules = Object.freeze([
  'atomicFile.ts', 'desktopUpdateFeed.ts', 'desktopSignedUpdate.ts',
  'desktopUpdateJournal.ts', 'desktopUpdateStaging.ts', 'desktopUpdateOperation.ts',
  'desktopUpdateCheck.ts', 'desktopUpdateDownloadConsent.ts', 'desktopInstallIdentity.ts'
]);
export async function stageHydraMainUpdatePrimitives(destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of hydraMainUpdateModules) {
    await fs.copyFile(path.join(root, 'src', 'core', name), path.join(destination, name));
  }
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
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned installer changed: ${before}`);
    text = text.replace(before, after);
  };
  const replacements = new Map([
    ['AppPublisher=Microsoft Corporation', 'AppPublisher=Nico Dunlap'],
    ['AppPublisherURL=https://code.visualstudio.com/', 'AppPublisherURL=https://github.com/ndunl075/hydra'],
    ['AppSupportURL=https://code.visualstudio.com/', 'AppSupportURL=https://github.com/ndunl075/hydra/issues'],
    ['AppUpdatesURL=https://code.visualstudio.com/', 'AppUpdatesURL=https://github.com/ndunl075/hydra/releases'],
    ['OutputBaseFilename=VSCodeSetup', 'OutputBaseFilename=HydraSetup']
  ]);
  for (const [before, after] of replacements) {
    replaceOnce(before, after);
  }
  replaceOnce('CloseApplications=force', 'CloseApplications=no\nRestartApplications=no');
  replaceOnce('[Code]\nfunction IsBackgroundUpdate(): Boolean;', '[Code]\n#include "hydra-update-mode.iss"\nfunction IsBackgroundUpdate(): Boolean;');
  replaceOnce('  Result := True;\n\n  #if "user" == InstallTarget',
    `  Result := True;
  if (HydraUpdateSwitchState() < 0) or HydraHasSwitch('/UPDATE') or not HydraUpdateArgumentsValid() then begin
    Result := False;
    Exit;
  end;

  #if "user" == InstallTarget`);
  replaceOnce('function PrepareToInstall(var NeedsRestart: Boolean): String;\nbegin\n  if IsNotBackgroundUpdate() then',
    `function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := HydraCheckInstall();
  if Result <> '' then Exit;
  if IsHydraUpdate() then begin
    if CheckForMutexes('{#AppMutex},{#TunnelMutex},{#TunnelServiceMutex}') then
      Result := 'Stop all Hydra application and tunnel processes before updating.';
    Exit;
  end;
  if IsNotBackgroundUpdate() then`);
  replaceOnce('Result := not (IsBackgroundUpdate() and FileExists(Path));',
    'Result := not ((IsBackgroundUpdate() or IsHydraUpdate()) and FileExists(Path));');
  replaceOnce('function ShouldRunAfterUpdate(): Boolean;\nbegin\n  if IsBackgroundUpdate() then',
    'function ShouldRunAfterUpdate(): Boolean;\nbegin\n  if IsHydraUpdate() then\n    Result := False\n  else if IsBackgroundUpdate() then');
  replaceOnce('function WizardNotSilent(): Boolean;\nbegin\n  Result := not WizardSilent();',
    'function WizardNotSilent(): Boolean;\nbegin\n  Result := not WizardSilent() and not IsHydraUpdate();');
  replaceOnce('    end else begin\n      if IsVersionedUpdate() then begin',
    '    end else if not IsHydraUpdate() then begin\n      if IsVersionedUpdate() then begin');
  replaceOnce('    if ShouldRestartTunnelService then', '    if ShouldRestartTunnelService and not IsHydraUpdate() then');
  if (!/Name: "desktopicon";[^\r\n]*Flags: unchecked/.test(text) || !/Tasks: desktopicon/.test(text)) throw new Error('Installer desktop-shortcut checkbox contract changed.');
  const deleteSection = '[InstallDelete]';
  if (text.split(deleteSection).length !== 2) throw new Error('Pinned installer delete section changed.');
  // A future explicit repair may opt out of the shortcut; update mode leaves
  // existing task choices and shortcuts untouched.
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
export function installerInventorySource(text, inventoryScript, upstreamCommit) {
  if (typeof upstreamCommit !== 'string' || !/^[a-f0-9]{40}$/.test(upstreamCommit))
    throw new Error('Pinned upstream inventory commit is invalid.');
  const anchor = "fs.writeFileSync(productJsonPath, JSON.stringify(productJson, undefined, '\\t'));";
  if (text.split(anchor).length !== 2 || text.includes('HydraInstalledInventory.json'))
    throw new Error('Pinned installer inventory hook changed.');
  const hook = `${anchor}
		if (arch === 'x64' && target === 'user') {
			cp.execFileSync(process.execPath, [${JSON.stringify(inventoryScript)}, 'generate',
				'--source', sourcePath, '--product', productJsonPath, '--inno', issPath,
				'--inventory', path.join(outputPath, 'HydraInstalledInventory.json'),
				'--version', String(productJson.hydraVersion),
				'--source-commit', process.env.HYDRA_SOURCE_COMMIT || '', '--upstream-commit', ${JSON.stringify(upstreamCommit)}], { stdio: 'inherit' });
		}`;
  return text.replace(anchor, hook);
}
export function windowsExecutableVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || match.slice(1, 4).some(part => Number(part) > 65535)) throw new Error('Hydra version is invalid for a Windows executable.');
  return {
    'file-version': match.slice(1, 4).join('.'),
    'product-version': match.slice(1, 4).join('.'),
    'version-string': { ProductName: 'Hydra', ProductVersion: version, FileVersion: version, CompanyName: 'Nico Dunlap', OriginalFilename: 'Hydra.exe' }
  };
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
export function brandedThemeStartup(text) {
  const constructor = /new ThemeConfiguration\(configurationService, hostColorService, isNewUser\d*\);/g;
  const migration = 'await this.migrateAutoDetectColorScheme();';
  if ([...text.matchAll(constructor)].length !== 1 || text.split(migration).length !== 2) throw new Error('Pinned theme startup contract changed.');
  return text.replace(constructor, 'new ThemeConfiguration(configurationService, hostColorService, false);')
    .replace(migration, '// Hydra honors its dark default without writing a system-theme preference for new users.');
}
export function brandedEditorGroupWatermark(text) {
  if (text.includes('renderHydraStartSurface')) throw new Error('Pinned watermark changed: Hydra start surface already exists.');
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned watermark changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce(
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';",
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';\nimport { ICommandService } from '../../../../platform/commands/common/commands.js';\nimport { IProductService } from '../../../../platform/product/common/productService.js';\nimport { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';\nimport { IHostService } from '../../../services/host/browser/host.js';\nimport { renderHydraStartSurface } from './hydraStartSurface.js';");
  replaceOnce(
    '\t\t@IStorageService private readonly storageService: IStorageService\n\t) {',
    '\t\t@IStorageService private readonly storageService: IStorageService,\n\t\t@ICommandService private readonly commandService: ICommandService,\n\t\t@IWorkspacesService private readonly workspacesService: IWorkspacesService,\n\t\t@IHostService private readonly hostService: IHostService,\n\t\t@IProductService private readonly productService: IProductService\n\t) {');
  const originalRender = '\tprivate render(): void {\n' +
    '\t\tthis.enabled = this.configurationService.getValue<boolean>(EditorGroupWatermark.SETTINGS_KEY);\n\n' +
    '\t\tclearNode(this.shortcuts);\n' +
    '\t\tthis.transientDisposables.clear();\n\n' +
    '\t\tif (!this.enabled) {\n' +
    '\t\t\treturn;\n' +
    '\t\t}\n\n' +
    '\t\tconst entries = this.filterEntries(this.workbenchState !== WorkbenchState.EMPTY ? workspaceEntries : emptyWindowEntries);\n' +
    '\t\tif (entries.length < EditorGroupWatermark.MINIMUM_ENTRIES) {\n' +
    '\t\t\tconst additionalEntries = this.filterEntries(otherEntries);\n' +
    '\t\t\tshuffle(additionalEntries);\n' +
    '\t\t\tentries.push(...additionalEntries.slice(0, EditorGroupWatermark.MINIMUM_ENTRIES - entries.length));\n' +
    '\t\t}\n\n' +
    "\t\tconst box = append(this.shortcuts, $('.watermark-box'));\n\n" +
    '\t\tconst update = () => {\n' +
    '\t\t\tclearNode(box);\n' +
    '\t\t\tthis.keybindingLabels.clear();\n\n' +
    '\t\t\tfor (const entry of entries) {\n' +
    '\t\t\t\tconst keys = this.keybindingService.lookupKeybinding(entry.id);\n' +
    '\t\t\t\tif (!keys) {\n' +
    '\t\t\t\t\tcontinue;\n' +
    '\t\t\t\t}\n\n' +
    "\t\t\t\tconst dl = append(box, $('dl'));\n" +
    "\t\t\t\tconst dt = append(dl, $('dt'));\n" +
    '\t\t\t\tdt.textContent = entry.text;\n\n' +
    "\t\t\t\tconst dd = append(dl, $('dd'));\n\n" +
    '\t\t\t\tconst label = this.keybindingLabels.add(new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true, ...defaultKeybindingLabelStyles }));\n' +
    '\t\t\t\tlabel.set(keys);\n' +
    '\t\t\t}\n' +
    '\t\t};\n\n' +
    '\t\tupdate();\n' +
    '\t\tthis.transientDisposables.add(this.keybindingService.onDidUpdateKeybindings(update));\n' +
    '\t}';
  const newRender = '\tprivate render(): void {\n' +
    '\t\tclearNode(this.shortcuts);\n' +
    '\t\tthis.transientDisposables.clear();\n\n' +
    '\t\trenderHydraStartSurface(this.shortcuts, this.commandService, this.workspacesService, this.hostService, this.productService);\n' +
    '\t}';
  replaceOnce(originalRender, newRender);
  return text;
}
export function brandedGettingStartedContent(text) {
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned getting-started content changed: ${before}`);
    text = text.replace(before, after);
  };
  const hydraCategory = `\t{
\t\tid: 'HydraSetup',
\t\ttitle: localize('gettingStarted.hydraSetup.title', "Get started with Hydra"),
\t\tdescription: localize('gettingStarted.hydraSetup.description', "Connect a provider, open a project, and start your first agent task"),
\t\tisFeatured: true,
\t\ticon: setupIcon,
\t\twalkthroughPageTitle: localize('gettingStarted.hydraSetup.walkthroughPageTitle', 'Setup Hydra'),
\t\tcontent: {
\t\t\ttype: 'steps',
\t\t\tsteps: [
\t\t\t\t{
\t\t\t\t\tid: 'hydraConnectProvider',
\t\t\t\t\ttitle: localize('gettingStarted.hydraConnectProvider.title', "Connect Claude or Codex"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraConnectProvider.description.interpolated', "Hydra runs the official Claude Code and Codex CLIs. Connect the one you use.\\n{0}", Button(localize('gettingStarted.hydraConnectProvider.button', "Provider Accounts"), 'command:hydra.openAccounts')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\tid: 'hydraOpenProject',
\t\t\t\t\ttitle: localize('gettingStarted.hydraOpenProject.title', "Open a project"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraOpenProject.description.interpolated', "Open a folder or clone a repository to start working.\\n{0}", Button(localize('gettingStarted.hydraOpenProject.button', "Open Folder"), 'command:workbench.action.files.openFolder')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t},
\t\t\t\t{
\t\t\t\t\tid: 'hydraStartTask',
\t\t\t\t\ttitle: localize('gettingStarted.hydraStartTask.title', "Start an agent task"),
\t\t\t\t\tdescription: localize('gettingStarted.hydraStartTask.description.interpolated', "Give Hydra a focused task. The agent works in its own isolated worktree while your editor stays untouched.\\n{0}", Button(localize('gettingStarted.hydraStartTask.button', "New Task"), 'command:hydra.newTask')),
\t\t\t\t\tmedia: { type: 'markdown', path: 'empty' },
\t\t\t\t}
\t\t\t]
\t\t}
\t},

\t{
\t\tid: 'Setup',`;
  replaceOnce("export const walkthroughs: GettingStartedWalkthroughContent = [\n\t{\n\t\tid: 'Setup',", `export const walkthroughs: GettingStartedWalkthroughContent = [\n${hydraCategory}`);
  replaceOnce(
    "\t\tid: 'Setup',\n\t\ttitle: localize('gettingStarted.setup.title', \"Get started with VS Code\"),\n\t\tdescription: localize('gettingStarted.setup.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: true,",
    "\t\tid: 'Setup',\n\t\ttitle: localize('gettingStarted.setup.title', \"Get started with VS Code\"),\n\t\tdescription: localize('gettingStarted.setup.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: false,");
  replaceOnce(
    "\t\tid: 'SetupWeb',\n\t\ttitle: localize('gettingStarted.setupWeb.title', \"Get Started with VS Code for the Web\"),\n\t\tdescription: localize('gettingStarted.setupWeb.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: true,",
    "\t\tid: 'SetupWeb',\n\t\ttitle: localize('gettingStarted.setupWeb.title', \"Get Started with VS Code for the Web\"),\n\t\tdescription: localize('gettingStarted.setupWeb.description', \"Customize your editor, learn the basics, and start coding\"),\n\t\tisFeatured: false,");
  return text;
}
export function brandedStartupPage(text) {
  const replaceOnce = (before, after) => {
    if (text.split(before).length !== 2) throw new Error(`Pinned startup page changed: ${before}`);
    text = text.replace(before, after);
  };
  replaceOnce(
    "import { IWorkspaceContextService, UNKNOWN_EMPTY_WINDOW_WORKSPACE, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';",
    "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';");
  const originalMethod = '\tprivate tryOpenWalkthroughForFolder(): boolean {\n' +
    '\t\tconst toRestore = this.storageService.get(restoreWalkthroughsConfigurationKey, StorageScope.PROFILE);\n' +
    '\t\tif (!toRestore) {\n' +
    '\t\t\treturn false;\n' +
    '\t\t}\n' +
    '\t\telse {\n' +
    '\t\t\tconst restoreData: RestoreWalkthroughsConfigurationValue = JSON.parse(toRestore);\n' +
    '\t\t\tconst currentWorkspace = this.contextService.getWorkspace();\n' +
    '\t\t\tif (restoreData.folder === UNKNOWN_EMPTY_WINDOW_WORKSPACE.id || restoreData.folder === currentWorkspace.folders[0].uri.toString()) {\n' +
    '\t\t\t\tconst options: GettingStartedEditorOptions = { selectedCategory: restoreData.category, selectedStep: restoreData.step, pinned: false, preserveFocus: this.shouldPreserveFocus() };\n' +
    '\t\t\t\tthis.editorService.openEditor({\n' +
    '\t\t\t\t\tresource: GettingStartedInput.RESOURCE,\n' +
    '\t\t\t\t\toptions\n' +
    '\t\t\t\t});\n' +
    '\t\t\t\tthis.storageService.remove(restoreWalkthroughsConfigurationKey, StorageScope.PROFILE);\n' +
    '\t\t\t\treturn true;\n' +
    '\t\t\t}\n' +
    '\t\t}\n' +
    '\t\treturn false;\n' +
    '\t}';
  const newMethod = '\tprivate tryOpenWalkthroughForFolder(): boolean {\n' +
    '\t\t// Hydra: never auto-reopen a walkthrough over the start surface.\n' +
    '\t\treturn false;\n' +
    '\t}';
  replaceOnce(originalMethod, newMethod);
  return text;
}
const hydraStartSurfaceCss = `
.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts:has(.hydra-start-surface) {
	display: block !important;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark:has(.hydra-start-surface) .letterpress {
	display: none;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 20px;
	width: 100%;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-title-row {
	display: flex;
	align-items: center;
	gap: 12px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-logo {
	width: 40px;
	height: 40px;
	background-image: url('./letterpress-light.svg');
	background-size: contain;
	background-position: center;
	background-repeat: no-repeat;
	flex-shrink: 0;
}

.monaco-workbench.vs-dark .part.editor > .content .editor-group-container .editor-group-watermark .shortcuts .hydra-start-surface-logo {
	background-image: url('./letterpress-dark.svg');
}

.monaco-workbench.hc-light .part.editor > .content .editor-group-container .editor-group-watermark .shortcuts .hydra-start-surface-logo {
	background-image: url('./letterpress-hcLight.svg');
}

.monaco-workbench.hc-black .part.editor > .content .editor-group-container .editor-group-watermark .shortcuts .hydra-start-surface-logo {
	background-image: url('./letterpress-hcDark.svg');
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-title {
	font-size: 26px;
	font-weight: 600;
	color: var(--vscode-foreground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-actions {
	display: grid;
	grid-template-columns: repeat(2, minmax(220px, 1fr));
	gap: 12px;
	width: 100%;
	max-width: 460px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 14px 16px;
	border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
	border-radius: 5px;
	background-color: var(--vscode-editorWidget-background);
	color: var(--vscode-foreground);
	font-size: 13px;
	cursor: pointer;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card:hover {
	background-color: var(--vscode-list-hoverBackground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-card .codicon {
	color: inherit !important;
	font-size: 18px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	width: 100%;
	max-width: 460px;
	gap: 6px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents-title {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 2px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recents-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 8px;
	border: none;
	border-radius: 4px;
	background-color: transparent;
	color: var(--vscode-foreground);
	text-align: left;
	cursor: pointer;
	overflow: hidden;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item:hover {
	background-color: var(--vscode-list-hoverBackground);
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item .codicon {
	color: var(--vscode-descriptionForeground) !important;
	flex-shrink: 0;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-text {
	display: flex;
	flex: 1;
	justify-content: space-between;
	align-items: baseline;
	gap: 12px;
	overflow: hidden;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-label {
	font-size: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex-shrink: 0;
}

.monaco-workbench .part.editor > .content .editor-group-container > .editor-group-watermark .shortcuts .hydra-start-surface-recent-item-path {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
`;
export function brandedWatermarkLayout(text) {
  const container = '\tmax-width: 272px;';
  const logo = '\tmax-width: 256px;';
  if (text.split(container).length !== 2 || text.split(logo).length !== 2) throw new Error('Pinned watermark layout contract changed.');
  if (text.includes('.hydra-start-surface')) throw new Error('Pinned watermark layout already has Hydra start surface styles.');
  // Native group sizing still constrains narrow/split editors; only the full empty editor grows.
  const sized = text.replace(container, '\twidth: 100%;\n\tmax-width: 380px;').replace(logo, '\tmax-width: 360px;');
  return `${sized}\n${hydraStartSurfaceCss}`;
}
export function brandedNativeThemeStartup(text) {
  const method = /(isAutoDetectColorScheme\(\)(?:: boolean)? \{)\s*if \(Setting\.DETECT_COLOR_SCHEME\.getValue\(this\.configurationService\)\) \{[\s\S]*?return false;\s*\}/g;
  const matches = [...text.matchAll(method)];
  if (matches.length !== 1 || !matches[0][0].includes('this.stateService.getItem(THEME_STORAGE_KEY)') || !matches[0][0].includes('userValue')) throw new Error('Pinned native theme startup contract changed.');
  return text.replace(method, '$1\n    return Setting.DETECT_COLOR_SCHEME.getValue(this.configurationService);\n  }');
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
    const electronMainPath = 'src/vs/code/electron-main/main.ts';
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraUpdateTrust.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdateTrust.ts'));
    await fs.writeFile(path.join(source, electronMainPath), brandedElectronMain(await git(['show', `${pin.commit}:${electronMainPath}`])));
    await stageHydraMainUpdatePrimitives(path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdate'));
    const electronAppPath = 'src/vs/code/electron-main/app.ts';
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraUpdateService.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraUpdateService.ts'));
    await fs.copyFile(path.join(root, 'desktop', 'main', 'hydraInstallIdentity.ts'), path.join(source, 'src', 'vs', 'code', 'electron-main', 'hydraInstallIdentity.ts'));
    await fs.writeFile(path.join(source, electronAppPath), brandedElectronApp(await git(['show', `${pin.commit}:${electronAppPath}`])));
  const themeStartupPath = 'src/vs/workbench/services/themes/browser/workbenchThemeService.ts';
  await fs.writeFile(path.join(source, themeStartupPath), brandedThemeStartup(await git(['show', `${pin.commit}:${themeStartupPath}`])));
  const nativeThemePath = 'src/vs/platform/theme/electron-main/themeMainServiceImpl.ts';
  await fs.writeFile(path.join(source, nativeThemePath), brandedNativeThemeStartup(await git(['show', `${pin.commit}:${nativeThemePath}`])));
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
  await fs.copyFile(path.join(root, 'desktop', 'hydra-update-mode.iss'), path.join(source, 'build', 'win32', 'hydra-update-mode.iss'));
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(installer));
  const electron = await git(['show', `${pin.commit}:build/lib/electron.ts`]);
  if (!electron.includes("companyName: 'Microsoft Corporation'")) throw new Error('Pinned executable publisher metadata changed.');
  await fs.writeFile(path.join(source, 'build', 'lib', 'electron.ts'), electron.replace("companyName: 'Microsoft Corporation'", "companyName: 'Nico Dunlap'"));
  await stageWatermarks(path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media'), await fs.readFile(path.join(root, 'hydra-logo.png')));
  const watermarkCss = 'src/vs/workbench/browser/parts/editor/media/editorgroupview.css';
  await fs.writeFile(path.join(source, watermarkCss), brandedWatermarkLayout(await git(['show', `${pin.commit}:${watermarkCss}`])));
  const editorPartsDir = path.join(source, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor');
  await fs.copyFile(path.join(root, 'desktop', 'workbench', 'hydraStartSurface.ts'), path.join(editorPartsDir, 'hydraStartSurface.ts'));
  const editorGroupWatermarkPath = 'src/vs/workbench/browser/parts/editor/editorGroupWatermark.ts';
  await fs.writeFile(path.join(source, editorGroupWatermarkPath), brandedEditorGroupWatermark(await git(['show', `${pin.commit}:${editorGroupWatermarkPath}`])));
  const startupPagePath = 'src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts';
  await fs.writeFile(path.join(source, startupPagePath), brandedStartupPage(await git(['show', `${pin.commit}:${startupPagePath}`])));
  const gettingStartedContentPath = 'src/vs/workbench/contrib/welcomeGettingStarted/common/gettingStartedContent.ts';
  await fs.writeFile(path.join(source, gettingStartedContentPath), brandedGettingStartedContent(await git(['show', `${pin.commit}:${gettingStartedContentPath}`])));
  console.log(`Prepared Hydra ${manifest.version}: Code - OSS ${pin.tag} at ${pin.commit}.`);
}
export async function stageHydra(destination) {
  const manifest = await readJson(path.join(root, 'package.json'));
  manifest.contributes.configurationDefaults = { ...manifest.contributes.configurationDefaults,
    'workbench.colorTheme': 'Hydra Dark', 'workbench.preferredDarkColorTheme': 'Hydra Dark',
    'window.autoDetectColorScheme': false,
    'workbench.secondarySideBar.defaultVisibility': 'visible' };
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
  installedUpdateTrust(product.hydraUpdateTrust);
  if (!isDeepStrictEqual(product.hydraUpdateTrust, brand.hydraUpdateTrust)) throw new Error('Installed desktop update trust differs from the reviewed release configuration.');
  const bundled = path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager');
  const manifest = await readJson(path.join(bundled, 'package.json'));
  if (manifest.publisher !== 'nico-dunlap' || manifest.name !== 'hydra-agent-manager') throw new Error('Built-in Hydra extension is missing.');
  const release = await readJson(path.join(root, 'package.json'));
  if (product.hydraVersion !== release.version || manifest.version !== release.version) throw new Error('Desktop product and bundled module versions differ from the Hydra release.');
  const nativeHelperPath = path.join(output, 'tools', 'HydraUpdateVerify.exe');
  const nativeHelper = await fs.readFile(nativeHelperPath);
  if (nativeHelper.length < 1024 || nativeHelper.subarray(0, 2).toString() !== 'MZ') throw new Error('Disabled native update helper is missing or invalid.');
  for (const name of await fs.readdir(path.join(output, 'tools'))) {
    if (/fixture/i.test(name)) throw new Error('Native fixture executable leaked into the desktop package.');
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-pe-version.ps1'), '-ExecutablePath', path.join(output, 'Hydra.exe')], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 });
    const pe = JSON.parse(stdout);
    if (pe.ProductName !== 'Hydra' || pe.ProductVersion !== release.version || pe.CompanyName !== 'Nico Dunlap') throw new Error('Hydra executable PE release identity does not match the product and bundled module.');
    const helperVersion = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-pe-version.ps1'), '-ExecutablePath', nativeHelperPath], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 })).stdout);
    if (helperVersion.ProductName !== 'Hydra' || helperVersion.ProductVersion !== release.version || helperVersion.CompanyName !== 'Nico Dunlap') throw new Error('Native update helper PE release identity differs.');
  }
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
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-native-helper-build.ps1'), '-OutputPath', path.join(output, 'tools', 'HydraUpdateVerify.exe')], root);
  // Stamp after upstream packaging and before signing; Code - OSS otherwise
  // retains its 1.113.0 PE ProductVersion even when product.json is Hydra.
  const rcedit = promisify(createRequire(path.join(source, 'package.json'))('rcedit'));
  const release = await readJson(path.join(root, 'package.json'));
  await rcedit(path.join(output, 'Hydra.exe'), windowsExecutableVersion(release.version));
  const helperVersion = windowsExecutableVersion(release.version);
  helperVersion['version-string'].OriginalFilename = 'HydraUpdateVerify.exe';
  await rcedit(path.join(output, 'tools', 'HydraUpdateVerify.exe'), helperVersion);
  await stageHydra(path.join(output, 'resources', 'app', 'extensions', 'hydra-agent-manager'));
  await verify();
}
export async function smoke() {
  await verify();
  await run(process.execPath, [path.join(root, 'scripts', 'desktop-appearance-smoke.mjs')], root);
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
  await fs.writeFile(path.join(source, sourcePath), installerInventorySource(
    installerVersionSource(await git(['show', `${pin.commit}:${sourcePath}`]), manifest.version),
    path.join(root, 'scripts', 'desktop-installed-inventory.mjs'), pin.commit));
  await fs.copyFile(path.join(root, 'desktop', 'hydra-update-mode.iss'), path.join(source, 'build', 'win32', 'hydra-update-mode.iss'));
  await fs.writeFile(path.join(source, 'build', 'win32', 'code.iss'), brandedInstaller(await git(['show', `${pin.commit}:build/win32/code.iss`])));
  // The standalone app task does not stage installer-specific updater tools.
  // Use the pinned task, including Hydra's icon, before compiling [Files].
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-inno-updater'], source);
  for (const name of ['inno_updater.exe','vcruntime140.dll','HydraUpdateVerify.exe']) {
    const tool=await fs.readFile(path.join(output,'tools',name));
    if(tool.length<1024||tool.subarray(0,2).toString()!=='MZ')throw new Error(`Required installer tool is missing or invalid: ${name}`);
  }
  const sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Hydra source commit is invalid.');
  await npm(['run', 'gulp', '--', 'vscode-win32-x64-user-setup'], source, { HYDRA_SOURCE_COMMIT: sourceCommit });
  const setup = path.join(source, '.build', 'win32-x64', 'user-setup', 'HydraSetup.exe');
  const setupDirectory = path.dirname(setup);
  await run(process.execPath, [path.join(root, 'scripts', 'desktop-installed-inventory.mjs'), 'verify-inputs',
    '--source', output, '--product', path.join(setupDirectory, 'product.json'),
    '--inno', path.join(source, 'build', 'win32', 'code.iss'),
    '--inventory', path.join(setupDirectory, 'HydraInstalledInventory.json'),
    '--version', manifest.version, '--source-commit', sourceCommit, '--upstream-commit', pin.commit], root);
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
