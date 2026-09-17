import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = process.cwd();
const localCode = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined;
await fs.mkdir(path.join(root, '.test-build'), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, '.test-build', 'smoke spaces ü-'));
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
await fs.mkdir(path.join(repository, '.vscode'));
await fs.writeFile(path.join(repository, '.vscode', 'settings.json'), JSON.stringify({ 'hydra.codexPath': 'relative-invalid-path' }));
const options = {
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist', 'smoke.cjs'),
  ...(localCode ? { vscodeExecutablePath: localCode } : {}),
  extensionTestsEnv: { HYDRA_TEST_REPOSITORY: await fs.realpath(repository), HYDRA_TEST_PROVIDER: provider, HYDRA_TEST_FIXTURE: fixture },
  // The official Windows test runner uses cmd.exe and requires explicit quoting for positional folders.
  launchArgs: [process.platform === 'win32' ? `"${repository}"` : repository, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', path.join(root, '.test-build', 'vscode-user-data')]
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
