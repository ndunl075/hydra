const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

async function waitForFile(file, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function refuseWrite(target) {
  const before = await hash(target.path);
  let errorCode = '';
  try {
    const handle = await fs.open(target.path, 'r+');
    await handle.close();
    throw new Error(`Packaged ${target.kind} unexpectedly opened for write.`);
  } catch (error) {
    if (String(error.message).includes('unexpectedly opened')) throw error;
    errorCode = String(error.code || '');
    if (!['EACCES', 'EPERM'].includes(errorCode)) {
      throw new Error(`Packaged ${target.kind} write failed for an unaccepted reason: ${errorCode || error}`);
    }
  }
  const after = await hash(target.path);
  if (before !== target.sha256 || after !== before) throw new Error(`Packaged ${target.kind} hash changed.`);
  return { kind: target.kind, path: target.path, sha256: after, errorCode };
}

async function runFirstPhase(context, config, workspace, checkpoint) {
  await checkpoint('editor');
  const marker = `saved-by-packaged-hydra:${config.nonce}`;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(config.editorFile));
  const editor = await vscode.window.showTextDocument(document);
  const changed = await editor.edit(builder => builder.insert(document.positionAt(document.getText().length), `${marker}\n`));
  if (!changed || !await document.save()) throw new Error('Packaged editor did not save the fixture file.');

  await checkpoint('terminal');
  const terminal = vscode.window.createTerminal({
    name: config.terminalName,
    cwd: workspace,
    shellPath: 'powershell.exe',
    shellArgs: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', config.terminalScript,
      '-OutputPath', config.terminalOutput,
      '-Nonce', config.nonce
    ]
  });
  terminal.show(false);
  await waitForFile(config.terminalOutput, 45_000);
  const terminalResult = await readJson(config.terminalOutput);
  if (terminalResult.nonce !== config.nonce || terminalResult.parentProcessId <= 0) {
    throw new Error('Integrated terminal result did not match the workflow nonce.');
  }
  terminal.dispose();

  await checkpoint('external-git');
  const git = await execute('git.exe', ['--version'], { cwd: workspace, windowsHide: true, timeout: 20_000 });
  if (!/^git version /i.test(git.stdout.trim())) throw new Error('External Git invocation returned unexpected output.');
  await checkpoint('fixture-cli');
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', config.fixtureCli, '-OutputPath', config.cliOutput, '-Nonce', config.nonce],
  { cwd: workspace, windowsHide: true, timeout: 20_000 });
  if ((await fs.readFile(config.cliOutput, 'utf8')).trim() !== config.nonce) throw new Error('Local fixture CLI result changed.');

  await checkpoint('protected-writes');
  const protectedWrites = [];
  for (const target of config.protectedTargets) protectedWrites.push(await refuseWrite(target));
  await checkpoint('built-in-extension');
  const hydra = vscode.extensions.getExtension('nico-dunlap.hydra-agent-manager');
  if (!hydra) throw new Error('Built-in Hydra extension is unavailable in the packaged app.');
  await hydra.activate();
  if (!hydra.isActive) throw new Error('Built-in Hydra extension did not activate.');

  await checkpoint('persistence');
  await vscode.workspace.getConfiguration('editor').update('fontSize', config.fontSize, vscode.ConfigurationTarget.Global);
  await context.globalState.update('workflowNonce', config.nonce);
  return {
    editorSaved: (await fs.readFile(config.editorFile, 'utf8')).includes(marker),
    terminal: terminalResult,
    externalGit: git.stdout.trim(),
    fixtureCli: 'passed',
    protectedWrites,
    builtInHydra: { id: hydra.id, active: hydra.isActive },
    userSetting: vscode.workspace.getConfiguration('editor').get('fontSize'),
    globalState: context.globalState.get('workflowNonce')
  };
}

async function runSecondPhase(context, config, checkpoint) {
  await checkpoint('restart-persistence');
  const text = await fs.readFile(config.editorFile, 'utf8');
  const installedExtension = vscode.extensions.getExtension('hydra-msix-workflow.hydra-msix-workflow');
  return {
    editorPersisted: text.includes(`saved-by-packaged-hydra:${config.nonce}`),
    userSetting: vscode.workspace.getConfiguration('editor').get('fontSize'),
    globalState: context.globalState.get('workflowNonce'),
    installedExtensionPath: installedExtension?.extensionPath || ''
  };
}

async function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const configPath = path.join(folder.uri.fsPath, '.hydra-msix-workflow.json');
  let config;
  try {
    config = await readJson(configPath);
  } catch {
    return;
  }
  const report = {
    schemaVersion: 1,
    status: 'started',
    nonce: config.nonce,
    phase: config.phase,
    appName: vscode.env.appName,
    extensionHostPid: process.pid,
    extensionHostParentPid: process.ppid,
    extensionHostExecutable: process.execPath,
    extensionPath: context.extensionPath,
    workspace: folder.uri.fsPath
  };
  const checkpoint = async stage => {
    await fs.writeFile(config.progressPath, JSON.stringify({
      schemaVersion: 1,
      status: 'started',
      phase: config.phase,
      stage,
      updatedAt: new Date().toISOString(),
      appName: report.appName,
      extensionHostPid: report.extensionHostPid,
      extensionHostParentPid: report.extensionHostParentPid,
      extensionHostExecutable: report.extensionHostExecutable,
      extensionPath: report.extensionPath,
      workspace: report.workspace
    }, null, 2) + '\n');
  };
  await checkpoint('activated');
  try {
    report.checks = config.phase === 1
      ? await runFirstPhase(context, config, folder.uri.fsPath, checkpoint)
      : await runSecondPhase(context, config, checkpoint);
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
