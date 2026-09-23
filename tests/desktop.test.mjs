import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { brandedSidebarTitleBar, brandedSidebarCss, brandedProduct, brandedElectronMain, brandedElectronApp, brandedInstaller, brandedThemeStartup, brandedNativeThemeStartup, installerVersionSource, windowsExecutableVersion, installedUpdateTrust, isolatedEditorTypes, stageHydra, stageHydraMainUpdatePrimitives, hydraMainUpdateModules, root } from '../scripts/desktop.mjs';

test('pinned Electron app uses only Hydra update service on Windows and refuses source drift', () => {
  const source = "import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';\nservices.set(IUpdateService, new SyncDescriptor(Win32UpdateService));";
  const branded = brandedElectronApp(source);
  assert.match(branded, /import \{ HydraUpdateService \} from '\.\/hydraUpdateService\.js';/);
  assert.match(branded, /services\.set\(IUpdateService, new SyncDescriptor\(HydraUpdateService\)\)/);
  assert.doesNotMatch(branded, /Win32UpdateService/);
  assert.throws(() => brandedElectronApp(branded), /already exists/);
  assert.throws(() => brandedElectronApp(source.replace('SyncDescriptor(Win32UpdateService)', 'SyncDescriptor(AnotherService)')), /Pinned Electron app changed/);
});

test('copied Electron-main update primitives compile under pinned NodeNext rules', async () => {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(parent, 'hydra-main-update-'));
  try {
    await stageHydraMainUpdatePrimitives(fixture);
    assert.deepEqual((await fs.readdir(fixture)).sort(), [...hydraMainUpdateModules].sort());
    const nodeTypes = path.dirname(createRequire(import.meta.url).resolve('@types/node/package.json'));
    const options = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noImplicitReturns: true,
      noUnusedLocals: true, noUncheckedSideEffectImports: true, noEmit: true,
      skipLibCheck: true, typeRoots: [path.dirname(nodeTypes)], types: ['node'] };
    const program = ts.createProgram(hydraMainUpdateModules.map(name => path.join(fixture, name)), options);
    const errors = ts.getPreEmitDiagnostics(program);
    assert.equal(errors.length, 0, ts.formatDiagnostics(errors, { getCanonicalFileName: file => file, getCurrentDirectory: () => fixture, getNewLine: () => '\n' }));
  } finally {
    if (!fixture.startsWith(parent + path.sep)) throw new Error('Unsafe main update test cleanup.');
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('pinned Electron main initializes installed Hydra trust and refuses source drift', () => {
  const source = "import { CodeApplication } from './app.js';\nawait this.initServices(environmentMainService, userDataProfilesMainService, configurationService, stateMainService, productService);";
  const branded = brandedElectronMain(source);
  assert.match(branded, /import \{ initializeHydraUpdateTrust \} from '\.\/hydraUpdateTrust\.js';/);
  assert.match(branded, /initializeHydraUpdateTrust\(productService\);/);
  assert.match(branded, /catch \{ console\.error\("Hydra updates disabled: invalid installed trust\."\); \}/);
  assert.throws(() => brandedElectronMain(branded), /Pinned Electron main changed/);
  assert.throws(() => brandedElectronMain(source.replace('productService);', 'missingService);')), /Pinned Electron main changed/);
});

test('nested editor compiles its own API declarations without loading the parent extension API', async () => {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(parent, 'desktop-types-'));
  try {
    const source = path.join(fixture, '.desktop', 'code-oss', 'src');
    const ancestorTypes = path.join(fixture, 'node_modules', '@types', 'vscode');
    await fs.mkdir(path.join(source, 'vscode-dts'), { recursive: true });
    await fs.mkdir(ancestorTypes, { recursive: true });
    await fs.writeFile(path.join(ancestorTypes, 'index.d.ts'), 'declare module "vscode" { export class Position { oldApi: string; } }');
    await fs.writeFile(path.join(source, 'vscode-dts', 'vscode.d.ts'), 'declare module "vscode" { export class Position { editorApi: string; } }');
    await fs.writeFile(path.join(source, 'probe.ts'), 'import type { Position } from "vscode"; export function probe(p: Position): string { return p.editorApi; }');
    const base = { compilerOptions: { strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext' } };
    const child = { extends: './tsconfig.base.json', include: ['probe.ts', 'vscode-dts/*.d.ts'] };
    await fs.writeFile(path.join(source, 'tsconfig.json'), JSON.stringify(child));
    const compile = async config => {
      await fs.writeFile(path.join(source, 'tsconfig.base.json'), JSON.stringify(config));
      const parsed = ts.getParsedCommandLineOfConfigFile(path.join(source, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) });
      assert.deepEqual(parsed.errors, []);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      return { program, diagnostics: ts.getPreEmitDiagnostics(program) };
    };
    const before = await compile(base);
    assert.ok(before.program.getSourceFiles().some(file => file.fileName.replaceAll('\\', '/').endsWith('/node_modules/@types/vscode/index.d.ts')));
    assert.ok(before.diagnostics.some(diagnostic => diagnostic.code === 2300), 'fixture must reproduce duplicate editor API declarations');
    const after = await compile(isolatedEditorTypes(base, './vscode-dts/vscode.d.ts', ['../node_modules/@types']));
    assert.equal(after.diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(after.diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => source, getNewLine: () => '\n' }));
    assert.ok(!after.program.getSourceFiles().some(file => file.fileName.replaceAll('\\', '/').endsWith('/node_modules/@types/vscode/index.d.ts')));
    assert.equal(after.program.getCompilerOptions().skipLibCheck, undefined);
    // The editor sources pin an explicit "types" list, so prepare() passes no
    // typeRoots for them: forcing one would make every "types" entry resolve
    // under that single root and drop scoped packages like @webgpu/types. The
    // explicit list alone must still keep the ancestor @types/vscode out.
    await fs.writeFile(path.join(source, 'tsconfig.json'), JSON.stringify({ ...child, compilerOptions: { types: [] } }));
    const pinned = await compile(isolatedEditorTypes(base, './vscode-dts/vscode.d.ts', null));
    assert.equal(pinned.program.getCompilerOptions().typeRoots, undefined);
    assert.equal(pinned.diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(pinned.diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => source, getNewLine: () => '\n' }));
    assert.ok(!pinned.program.getSourceFiles().some(file => file.fileName.replaceAll('\\', '/').endsWith('/node_modules/@types/vscode/index.d.ts')));
  } finally {
    if (!fixture.startsWith(parent + path.sep)) throw new Error('Unsafe desktop test cleanup.');
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('standalone identity isolates Hydra from VS Code/Code OSS and retains upstream MIT attribution', () => {
  const original = { nameShort: 'Code - OSS', dataFolderName: '.vscode-oss', licenseName: 'MIT', licenseUrl: 'upstream-license', extensionsGallery: { serviceUrl: 'microsoft-marketplace' }, updateUrl: 'microsoft-update', builtInExtensions: [{ name: 'external-extension' }] };
  const product = brandedProduct(original, '0.8.0');
  assert.equal(product.nameShort, 'Hydra');
  assert.equal(product.dataFolderName, '.hydra');
  assert.equal(product.applicationName, 'hydra');
  assert.equal(product.win32MutexName, 'hydra-ide');
  assert.equal(product.win32AppUserModelId, 'Hydra.IDE');
  assert.equal(product.licenseName, 'MIT');
  assert.equal(product.licenseUrl, 'upstream-license');
  assert.equal(product.hydraVersion, '0.8.0');
  assert.equal(product.enableTelemetry, false);
  assert.equal(product.extensionsGallery, undefined);
  assert.equal(product.updateUrl, undefined);
  assert.equal(installedUpdateTrust(product.hydraUpdateTrust).status, 'disabled');
  assert.deepEqual(product.builtInExtensions, []);
  const ids = [product.win32x64AppId, product.win32x64UserAppId, product.win32arm64AppId, product.win32arm64UserAppId];
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^\{\{[0-9A-F-]{36}\}$/);
  assert.equal(original.nameShort, 'Code - OSS');
});
test('installed update trust stays disabled without owner values and rejects incomplete activation', () => {
  const disabled = { schemaVersion: 1, status: 'disabled', product: 'Hydra', channel: 'stable', target: { platform: 'win32', architecture: 'x64', installTarget: 'user' } };
  assert.equal(installedUpdateTrust(disabled).status, 'disabled');
  assert.throws(() => installedUpdateTrust({ ...disabled, origin: 'https://updates.example.com' }), /invalid/);
  assert.throws(() => installedUpdateTrust({ ...disabled, status: 'enabled' }), /invalid/);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const enabled = { ...disabled, status: 'enabled', origin: 'https://updates.example.com', keyId: 'stable-2026', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), authenticodeSigners: [{ subject: 'CN=Hydra Release', thumbprint: 'A'.repeat(40) }] };
  assert.equal(installedUpdateTrust(enabled).status, 'enabled');
  for (const changed of [
    { ...enabled, origin: 'http://updates.example.com' },
    { ...enabled, origin: 'https://127.0.0.1' },
    { ...enabled, keyId: 'bad key' },
    { ...enabled, publicKeyPem: 'not a key' },
    { ...enabled, publicKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    { ...enabled, authenticodeSigners: [enabled.authenticodeSigners[0], enabled.authenticodeSigners[0]] },
    { ...enabled, target: { ...enabled.target, installTarget: 'system' } }
  ]) assert.throws(() => installedUpdateTrust(changed), /invalid/);
});
test('installer branding preserves optional unchecked desktop shortcut and rejects upstream drift', () => {
  const original = [
    '[Setup]', 'CloseApplications=force', '[InstallDelete]',
    'AppPublisher=Microsoft Corporation', 'AppPublisherURL=https://code.visualstudio.com/',
    'AppSupportURL=https://code.visualstudio.com/', 'AppUpdatesURL=https://code.visualstudio.com/',
    'OutputBaseFilename=VSCodeSetup',
    'Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked',
    'Name: "{autodesktop}\\Hydra"; Tasks: desktopicon',
    '[Code]', 'function IsBackgroundUpdate(): Boolean;',
    'function InitializeSetup(): Boolean;', 'begin', '  Result := True;', '', '  #if "user" == InstallTarget',
    'function WizardNotSilent(): Boolean;', 'begin', '  Result := not WizardSilent();',
    'function PrepareToInstall(var NeedsRestart: Boolean): String;', 'begin', '  if IsNotBackgroundUpdate() then',
    'Result := not (IsBackgroundUpdate() and FileExists(Path));',
    'function ShouldRunAfterUpdate(): Boolean;', 'begin', '  if IsBackgroundUpdate() then',
    '    end else begin', '      if IsVersionedUpdate() then begin',
    '    if ShouldRestartTunnelService then'
  ].join('\n');
  const result = brandedInstaller(original);
  assert.match(result, /AppPublisher=Nico Dunlap/);
  assert.match(result, /OutputBaseFilename=HydraSetup/);
  assert.match(result, /Name: "desktopicon";[^\n]*Flags: unchecked/);
  assert.match(result, /Tasks: desktopicon/);
  assert.match(result, /Name: "\{autodesktop\}\\\{#NameLong\}\.lnk"; Tasks: not desktopicon; Check: ShouldUpdateShortcut/);
  assert.match(result, /CloseApplications=no\nRestartApplications=no/);
  assert.match(result, /#include "hydra-update-mode\.iss"/);
  assert.match(result, /Result := HydraCheckInstall\(\);/);
  assert.match(result, /if IsHydraUpdate\(\) then\n    Result := False/);
  assert.throws(() => brandedInstaller(original.replace('Flags: unchecked', 'Flags: checkedonce')), /checkbox contract/);
  assert.throws(() => brandedInstaller(original.replace('VSCodeSetup', 'ChangedSetup')), /Pinned installer changed/);
});
test('installer versions follow Hydra while preserving the editor API version and refusing source drift', () => {
  const original = "Version: pkg.version,\nRawVersion: pkg.version.replace(/-\\w+$/, ''),\nEditorVersion: pkg.version";
  const changed = installerVersionSource(original, '0.12.3-preview.1');
  assert.match(changed, /Version: "0.12.3-preview.1"/);
  assert.match(changed, /RawVersion: "0.12.3"/);
  assert.match(changed, /EditorVersion: pkg.version/);
  assert.throws(() => installerVersionSource(original, '70000.0.0'), /invalid/);
  assert.throws(() => installerVersionSource(original, '1.2.3";process.exit()'), /invalid/);
  assert.throws(() => installerVersionSource(original.replace('Version: pkg.version,', 'Version: changed,'), '1.2.3'), /contract changed/);
});
test('Windows executable metadata uses the Hydra release instead of the editor API version', async () => {
  const release = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const metadata = windowsExecutableVersion(release);
  assert.equal(metadata['version-string'].ProductName, 'Hydra');
  assert.equal(metadata['version-string'].ProductVersion, release);
  assert.equal(metadata['file-version'], release.split('-')[0]);
  assert.equal(metadata['product-version'], release.split('-')[0]);
  assert.throws(() => windowsExecutableVersion('65536.0.0'), /invalid/);
});
test('Hydra startup honors explicit appearance instead of forcing system detection for new users; upstream drift refuses', () => {
  for (const name of ['isNewUser', 'isNewUser3']) {
    // The fixture carries the upstream shape the guards depend on: the new-user
    // probe, the constructor argument, the migration call, and the helper the
    // call is the only caller of. The vendored tsconfig sets noUnusedLocals, so
    // dropping the call without the probe and the helper breaks the build.
    const original = `\t\tconst ${name} = this.storageService.isNew(StorageScope.APPLICATION);\n`
      + `\t\tthis.settings = new ThemeConfiguration(configurationService, hostColorService, ${name});\n`
      + '\t\tawait this.migrateAutoDetectColorScheme();\n'
      + '\t}\n\n'
      + "\t/**\n\t * For new users who haven't explicitly configured `window.autoDetectColorScheme`,\n"
      + '\t * persist `true` so that auto-detect becomes the default going forward.\n\t */\n'
      + '\tprivate async migrateAutoDetectColorScheme(): Promise<void> {\n'
      + '\t\tif (!this.storageService.isNew(StorageScope.APPLICATION)) {\n\t\t\treturn;\n\t\t}\n'
      + '\t\tawait this.configurationService.updateValue(ThemeSettings.DETECT_COLOR_SCHEME, true);\n'
      + '\t}\n';
    const branded = brandedThemeStartup(original);
    assert.ok(branded.includes('new ThemeConfiguration(configurationService, hostColorService, false);'));
    assert.ok(!branded.includes('await this.migrateAutoDetectColorScheme();'));
    // Nothing the injection orphans may survive, or noUnusedLocals fails the build.
    assert.ok(!branded.includes(`const ${name} =`));
    assert.ok(!branded.includes('migrateAutoDetectColorScheme'));
    assert.ok(!branded.includes('auto-detect becomes the default'));
    assert.throws(() => brandedThemeStartup(original + original), /contract changed/);
    assert.throws(() => brandedThemeStartup(original.replace('hostColorService', 'changedService')), /contract changed/);
    assert.throws(() => brandedThemeStartup(original.replace('\t\tawait this.migrateAutoDetectColorScheme();\n', '')), /contract changed/);
    assert.throws(() => brandedThemeStartup(original.replace(`const ${name} = this.storageService.isNew`, `const ${name} = this.storageService.renamed`)), /contract changed/);
    assert.throws(() => brandedThemeStartup(original.replace('\tprivate async migrateAutoDetectColorScheme(): Promise<void> {\n', '')), /helper changed/);
  }
});

test('native splash honors configured automatic detection instead of overriding it on fresh installs', () => {
  const original = `isAutoDetectColorScheme() { if (Setting.DETECT_COLOR_SCHEME.getValue(this.configurationService)) { return true; } if (!this.stateService.getItem(THEME_STORAGE_KEY)) { const { userValue } = this.configurationService.inspect(Setting.DETECT_COLOR_SCHEME.key); return userValue === void 0; } return false; }`;
  const branded = brandedNativeThemeStartup(original);
  for (const configured of [false, true]) {
    const service = new Function('Setting', `return { ${branded} };`)({ DETECT_COLOR_SCHEME: { getValue: () => configured } });
    service.stateService = { getItem: () => { throw new Error('Fresh-install state must not override the preference'); } };
    assert.equal(service.isAutoDetectColorScheme(), configured);
  }
  assert.throws(() => brandedNativeThemeStartup(original + original), /contract changed/);
  assert.throws(() => brandedNativeThemeStartup(original.replace('THEME_STORAGE_KEY', 'changed')), /contract changed/);
});

test('standalone staging embeds the real Hydra runtime and themes with an app-only default', async () => {
  const parent = path.join(root, '.test-build');
  await fs.mkdir(parent, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(parent, 'desktop-stage-'));
  try {
    const original = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    await stageHydra(fixture);
    const staged = JSON.parse(await fs.readFile(path.join(fixture, 'package.json'), 'utf8'));
    assert.equal(staged.name, original.name);
    assert.equal(staged.version, original.version);
    assert.equal(staged.contributes.configurationDefaults['workbench.colorTheme'], 'Hydra Dark');
    assert.equal(staged.contributes.configurationDefaults['workbench.preferredDarkColorTheme'], 'Hydra Dark');
    assert.equal(staged.contributes.configurationDefaults['window.autoDetectColorScheme'], false);
    assert.equal(staged.contributes.configurationDefaults['workbench.secondarySideBar.defaultVisibility'], 'visible');
    assert.equal(original.contributes.configurationDefaults?.['workbench.secondarySideBar.defaultVisibility'], undefined);
    assert.equal(original.contributes.configurationDefaults?.['workbench.colorTheme'], undefined);
    assert.deepEqual(await fs.readFile(path.join(fixture, 'dist', 'extension.cjs')), await fs.readFile(path.join(root, 'dist', 'extension.cjs')));
    assert.deepEqual(await fs.readFile(path.join(fixture, 'hydra-logo.png')), await fs.readFile(path.join(root, 'hydra-logo.png')));
    await fs.access(path.join(fixture, 'themes', 'hydra-light.json'));
    await assert.rejects(fs.access(path.join(fixture, 'dist', 'smoke.cjs')));
    await assert.rejects(fs.access(path.join(fixture, 'node_modules')));
  } finally {
    if (!fixture.startsWith(parent + path.sep)) throw new Error('Unsafe desktop test cleanup.');
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('the top activity bar shares the sidebar title row instead of stacking a second header; drift refuses', () => {
  const method = 'protected getCompositeBarPosition(): CompositeBarPosition {';
  const original = `\t${method}\n\t\tswitch (activityBarPosition) {\n\t\t\tcase ActivityBarPosition.TOP: return CompositeBarPosition.TOP;\n\t\t\tcase ActivityBarPosition.BOTTOM: return CompositeBarPosition.BOTTOM;\n\t\t\tdefault: return CompositeBarPosition.TITLE;\n\t\t}\n\t}\n\tprivate getRememberedActivityBarVisiblePosition() { case ActivityBarPosition.TOP: return ActivityBarPosition.TOP; }`;
  const branded = brandedSidebarTitleBar(original);
  assert.match(branded, /case ActivityBarPosition\.TOP: return CompositeBarPosition\.TITLE;/);
  assert.doesNotMatch(branded, /case ActivityBarPosition\.TOP: return CompositeBarPosition\.TOP;/);
  // Bottom placement and the remembered-position helper are untouched.
  assert.match(branded, /case ActivityBarPosition\.BOTTOM: return CompositeBarPosition\.BOTTOM;/);
  assert.match(branded, /return ActivityBarPosition\.TOP;/);
  assert.throws(() => brandedSidebarTitleBar(original.replace('CompositeBarPosition.TOP;', 'CompositeBarPosition.TOP_CHANGED;')), /sidebar composite bar position changed/);
  assert.throws(() => brandedSidebarTitleBar(original.replace(method, 'protected renamed() {')), /sidebar composite bar position changed/);
});

test('the active sidebar icon gets a pill drawn behind it, never on the icon label, and drift refuses', () => {
  const original = '.monaco-workbench .part.sidebar > .title { height: 35px; }';
  const branded = brandedSidebarCss(original);
  assert.ok(branded.startsWith(original));
  assert.match(branded, /\.action-item\.icon\.checked \.active-item-indicator::before \{ background:/);
  // Extension icons are masks over the label background, so the label is never painted.
  assert.doesNotMatch(branded, /\.action-label \{[^}]*background/);
  assert.throws(() => brandedSidebarCss(branded), /already has Hydra styles/);
  assert.throws(() => brandedSidebarCss('.something-else {}'), /sidebar stylesheet changed/);
});
