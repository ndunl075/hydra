const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function activate() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const configPath = path.join(folder.uri.fsPath, '.hydra-msix-bootstrap.json');
  let config;
  try {
    config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return;
  }
  const report = { schemaVersion: 1, status: 'started', extensionHostPid: process.pid,
    extensionHostParentPid: process.ppid, extensionHostExecutable: process.execPath };
  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(config.vsix), {
      donotSync: true,
      enable: true,
      context: { skipWalkthrough: true }
    });
    report.command = 'workbench.extensions.installExtension';
    report.targetExtensionId = config.targetExtensionId;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error?.stack || String(error);
  }
  await fs.writeFile(config.reportPath, JSON.stringify(report, null, 2) + '\n');
  await delay(5_000);
  await vscode.commands.executeCommand('workbench.action.quit');
}

exports.activate = activate;
exports.deactivate = () => {};
