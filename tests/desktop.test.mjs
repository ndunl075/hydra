import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { brandedProduct, brandedInstaller, isolatedEditorTypes, stageHydra, root } from '../scripts/desktop.mjs';

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
  assert.deepEqual(product.builtInExtensions, []);
  const ids = [product.win32x64AppId, product.win32x64UserAppId, product.win32arm64AppId, product.win32arm64UserAppId];
  assert.equal(new Set(ids).size, 4);
  for (const id of ids) assert.match(id, /^\{\{[0-9A-F-]{36}\}$/);
  assert.equal(original.nameShort, 'Code - OSS');
});
test('installer branding preserves optional unchecked desktop shortcut and rejects upstream drift', () => {
  const original = 'AppPublisher=Microsoft Corporation\nAppPublisherURL=https://code.visualstudio.com/\nAppSupportURL=https://code.visualstudio.com/\nAppUpdatesURL=https://code.visualstudio.com/\nOutputBaseFilename=VSCodeSetup\nName: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked\nName: "{autodesktop}\\Hydra"; Tasks: desktopicon\n';
  const result = brandedInstaller(original);
  assert.match(result, /AppPublisher=Nico Dunlap/);
  assert.match(result, /OutputBaseFilename=HydraSetup/);
  assert.match(result, /Name: "desktopicon";[^\n]*Flags: unchecked/);
  assert.match(result, /Tasks: desktopicon/);
  assert.throws(() => brandedInstaller(original.replace('Flags: unchecked', 'Flags: checkedonce')), /checkbox contract/);
  assert.throws(() => brandedInstaller(original.replace('VSCodeSetup', 'ChangedSetup')), /Pinned installer changed/);
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
