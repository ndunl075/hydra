import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = process.cwd();
const localCode = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined;
const desktopCode = process.env.HYDRA_TEST_DESKTOP;
if (desktopCode && path.resolve(desktopCode) !== path.join(root, '.desktop', 'VSCode-win32-x64', 'Hydra.exe')) throw new Error('Desktop smoke must use the workspace-built Hydra executable.');
await fs.mkdir(path.join(root, '.test-build'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, '.test-build', 'smoke spaces ü-'));
let developmentPath = root, testsPath = path.join(root, 'dist', 'smoke.cjs');
if (desktopCode) {
  // A separate empty development harness runs API tests while Hydra loads from
  // the application's built-in extensions, never from this source checkout.
  developmentPath = path.join(fixture, 'harness');
  await fs.mkdir(developmentPath);
  await fs.writeFile(path.join(developmentPath, 'package.json'), JSON.stringify({ name: 'desktop-test-harness', publisher: 'hydra-internal', version: '1.0.0', engines: { vscode: '^1.95.0' } }));
  testsPath = path.join(developmentPath, 'smoke.cjs');
  await fs.copyFile(path.join(root, 'dist', 'smoke.cjs'), testsPath);
}
const repository = path.join(fixture, 'main repo');
await fs.mkdir(repository);
const git = args => execute('git', args, { cwd: repository, windowsHide: true });
await git(['init', '-b', 'main']);
await git(['config', 'user.email', 'hydra-test@example.invalid']);
await git(['config', 'user.name', 'Hydra Test']);
await git(['config', 'core.autocrlf', 'false']);
await fs.writeFile(path.join(repository, 'keep.txt'), 'base\n');
await git(['add', '.']);
await git(['commit', '-m', 'fixture']);
await fs.writeFile(path.join(repository, 'keep.txt'), 'main dirty\n');
const probe = path.join(fixture, 'probe.cjs');
await fs.writeFile(probe, await fs.readFile(path.join(root, 'tests', 'fixtures', 'claude-cli.cjs')));
const provider = path.join(fixture, process.platform === 'win32' ? 'provider.cmd' : 'provider');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await fs.writeFile(provider, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)} "$@"\n`, { mode: 0o755 });
const codexProbe = path.join(fixture, 'codex-probe.cjs');
await fs.writeFile(codexProbe, await fs.readFile(path.join(root, 'tests', 'fixtures', 'codex-cli.cjs')));
const codexProvider = path.join(fixture, process.platform === 'win32' ? 'codex.cmd' : 'codex');
await fs.writeFile(codexProvider, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "%~dp0codex-probe.cjs" %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(codexProbe)} "$@"\n`, { mode: 0o755 });
await fs.mkdir(path.join(repository, '.vscode'));
await fs.writeFile(path.join(repository, '.vscode', 'settings.json'), JSON.stringify({ 'hydra.codexPath': 'relative-invalid-path' }));
const options = {
  extensionDevelopmentPath: developmentPath, extensionTestsPath: testsPath,
  ...(desktopCode || localCode ? { vscodeExecutablePath: desktopCode || localCode } : {}),
  extensionTestsEnv: { HYDRA_TEST_REPOSITORY: await fs.realpath(repository), HYDRA_TEST_PROVIDER: provider, HYDRA_TEST_CODEX_PROVIDER: codexProvider, HYDRA_TEST_FIXTURE: fixture },
  // The official Windows test runner uses cmd.exe and requires explicit quoting for positional folders.
  launchArgs: [process.platform === 'win32' ? `"${repository}"` : repository, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', path.join(root, '.test-build', desktopCode ? 'hydra-user-data' : 'vscode-user-data')]
};
let passed = false;
try {
  await runTests(options);
  await runTests({ ...options, extensionTestsEnv: { ...options.extensionTestsEnv, HYDRA_TEST_RECOVERY: '1' } });
  const handoffs = JSON.parse(await fs.readFile(path.join(fixture, 'handoffs.json'), 'utf8'));
  for (const [index, handoffProvider] of ['claude', 'codex'].entries()) {
    const workspace = handoffs[index];
    await runTests({ ...options,
      extensionTestsEnv: { ...options.extensionTestsEnv, HYDRA_TEST_HANDOFF_PROVIDER: handoffProvider },
      launchArgs: [process.platform === 'win32' ? `"${workspace}"` : workspace, ...options.launchArgs.slice(1)]
    });
  }
  if ((await fs.readFile(path.join(repository, 'keep.txt'), 'utf8')) !== 'main dirty\n') throw new Error('Main checkout was modified.');
  passed = true;
} finally {
  if (!fixture.startsWith(path.join(root, '.test-build') + path.sep)) throw new Error('Unsafe test cleanup path.');
  if (passed) await fs.rm(fixture, { recursive: true, force: true });
  else console.error(`Test fixture retained for diagnosis: ${fixture}`);
}
