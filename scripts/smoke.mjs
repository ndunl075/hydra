import { runTests } from '@vscode/test-electron';
import path from 'node:path';
const root = process.cwd();
const localCode = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined;
await runTests({
  extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'dist', 'smoke.cjs'),
  ...(localCode ? { vscodeExecutablePath: localCode } : {}),
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', path.join(root, '.test-build', 'vscode-user-data')]
});
