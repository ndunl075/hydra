import fs from 'node:fs/promises';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = process.cwd();
const executable = path.join(root, '.desktop', 'VSCode-win32-x64', 'Hydra.exe');
await fs.access(executable);
await fs.mkdir(path.join(root, '.test-build'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, '.test-build', 'appearance spaces '));
const harness = path.join(fixture, 'harness');
await fs.mkdir(harness);
await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'appearance-acceptance', publisher: 'hydra-internal', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './index.cjs' }));
await fs.writeFile(path.join(harness, 'index.cjs'), 'exports.activate = () => {};\n');
await fs.writeFile(path.join(harness, 'test.cjs'), `const vscode = require('vscode');
const assert = require('node:assert/strict');
async function waitTheme(kind) {
  const deadline = Date.now() + 20000;
  while (vscode.window.activeColorTheme.kind !== kind && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(vscode.window.activeColorTheme.kind, kind, 'Actual native theme must match the saved/default appearance');
}
exports.run = async () => {
  assert.equal(vscode.env.appName, 'Hydra');
  const workbench = vscode.workspace.getConfiguration('workbench');
  const window = vscode.workspace.getConfiguration('window');
  assert.equal(workbench.inspect('colorTheme').defaultValue, 'Hydra Dark');
  assert.equal(workbench.inspect('preferredDarkColorTheme').defaultValue, 'Hydra Dark');
  assert.equal(window.inspect('autoDetectColorScheme').defaultValue, false);
  if (process.env.HYDRA_APPEARANCE_PHASE === 'automatic') {
    assert.equal(window.get('autoDetectColorScheme'), true);
    assert.equal(window.inspect('autoDetectColorScheme').globalValue, true);
    console.log('PASS: explicit automatic system-theme detection survives restart.');
  } else if (process.env.HYDRA_APPEARANCE_PHASE === 'light') {
    assert.equal(workbench.get('colorTheme'), 'Hydra Light');
    await waitTheme(vscode.ColorThemeKind.Light);
    assert.equal(window.get('autoDetectColorScheme'), false);
    assert.equal(window.inspect('autoDetectColorScheme').globalValue, undefined);
    console.log('PASS: saved light selection survives restart without being overwritten.');
    await window.update('autoDetectColorScheme', true, vscode.ConfigurationTarget.Global);
  } else {
    assert.equal(workbench.inspect('colorTheme').globalValue, undefined);
    assert.equal(workbench.get('colorTheme'), 'Hydra Dark');
    await waitTheme(vscode.ColorThemeKind.Dark);
    assert.equal(window.get('autoDetectColorScheme'), false);
    assert.equal(window.inspect('autoDetectColorScheme').globalValue, undefined);
    console.log('PASS: fresh native profile starts dark and writes no appearance preference.');
    await workbench.update('colorTheme', 'Hydra Light', vscode.ConfigurationTarget.Global);
  }
};\n`);
const quoted = value => process.platform === 'win32' ? `"${value}"` : value;
const options = {
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: quoted(harness),
  extensionTestsPath: quoted(path.join(harness, 'test.cjs')),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.join(fixture, 'user-data')]
};
for (const phase of ['fresh', 'light', 'automatic']) await runTests({ ...options, extensionTestsEnv: { HYDRA_APPEARANCE_PHASE: phase } });
console.log('PASS: isolated native appearance acceptance.');
