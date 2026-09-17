import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../src/core/model';
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the VS Code tab state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const managerOpen = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Agents');
async function correctCwd(task: Task): Promise<boolean> {
  try {
    const actual = await readFile(path.join(task.worktree, 'hydra-terminal-cwd.txt'), 'utf8');
    return path.relative(await realpath(actual), await realpath(task.worktree)) === '';
  } catch { return false; }
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('nico-dunlap.hydra-agent-manager');
  assert.ok(extension, 'Hydra extension is installed in the test host');
  await extension.activate();
  const repository = process.env.HYDRA_TEST_REPOSITORY;
  if (process.env.HYDRA_TEST_RECOVERY === '1') {
    const tasks = await vscode.commands.executeCommand<Task[]>('hydra.listTasks');
    assert.equal(tasks?.length, 3, 'All three task records are recovered');
    assert.ok(tasks.every(task => task.repository === repository && ['idle', 'interrupted'].includes(task.state)), 'No lost terminal is marked completed or running');
    for (const task of tasks) assert.equal((await readFile(path.join(task.worktree, 'keep.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'base\n');
    assert.ok(!vscode.window.terminals.some(terminal => terminal.name.startsWith('Hydra · ')), 'Recovery does not relaunch providers automatically');
    console.log('PASS: fresh host recovers three tasks without inventing completion or launching a model request.');
    return;
  }
  const document = await vscode.workspace.openTextDocument({ content: 'unsaved buffer\nkeep this selection\n', language: 'plaintext' });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  editor.selection = new vscode.Selection(1, 2, 1, 6);
  const terminal = vscode.window.createTerminal({ name: 'Hydra preservation smoke test' });
  terminal.show(true);
  const processId = await terminal.processId;
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      await vscode.commands.executeCommand('hydra.toggleMode');
      await waitFor(managerOpen);
      assert.equal(document.isClosed, false, 'Agents mode retains the unsaved document');
      assert.equal(document.getText(), 'unsaved buffer\nkeep this selection\n');
      assert.ok(vscode.window.terminals.includes(terminal), 'Agents mode retains the existing terminal');
      assert.ok(managerOpen(), 'Manager is open');
      await vscode.commands.executeCommand('hydra.toggleMode');
      await waitFor(() => !managerOpen() && vscode.window.activeTextEditor?.document === document);
      assert.equal(vscode.window.activeTextEditor?.document, document, 'Editor focus is restored');
      assert.equal(vscode.window.activeTextEditor?.selection.start.character, 2);
      assert.equal(vscode.window.activeTextEditor?.selection.end.character, 6);
      assert.equal(await terminal.processId, processId, 'The terminal process is preserved');
      assert.ok(vscode.window.terminals.includes(terminal));
      assert.ok(!managerOpen(), 'Manager leaves the editor surface');
    }
    console.log('PASS: three mode cycles preserve unsaved text, selection, focus, and a live terminal process.');
  } finally { terminal.dispose(); }
  if (repository && process.env.HYDRA_TEST_PROVIDER) {
    const config = vscode.workspace.getConfiguration('hydra');
    await config.update('claudePath', process.env.HYDRA_TEST_PROVIDER, vscode.ConfigurationTarget.Workspace);
    await config.update('codexPath', process.env.HYDRA_TEST_PROVIDER, vscode.ConfigurationTarget.Workspace);
    await config.update('maxConcurrentTasks', 2, vscode.ConfigurationTarget.Workspace);
    const tasks: Task[] = [];
    for (const provider of ['claude', 'codex', 'codex']) {
      const task = await vscode.commands.executeCommand<Task>('hydra.createTask', { repository, provider, title: `Smoke ${provider} ${tasks.length + 1}`, prompt: 'Test launch mechanics only; do not call a model.' });
      assert.ok(task);
      tasks.push(task);
    }
    assert.equal(new Set(tasks.map(task => task.worktree)).size, 3);
    for (const task of tasks.slice(0, 2)) await vscode.commands.executeCommand('hydra.launchTask', task.id);
    for (const task of tasks.slice(0, 2)) {
      await waitFor(() => correctCwd(task));
    }
    assert.equal(vscode.window.terminals.filter(item => item.name.startsWith('Hydra · ')).length, 2);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.launchTask', tasks[2]!.id), /limit/);
    await vscode.commands.executeCommand('hydra.launchTask', tasks[0]!.id);
    assert.equal(vscode.window.terminals.filter(item => item.name.startsWith('Hydra · ')).length, 2, 'Duplicate launch reveals the existing terminal');
    const pids = await Promise.all(vscode.window.terminals.filter(item => item.name.startsWith('Hydra · ')).map(item => item.processId));
    await vscode.commands.executeCommand('hydra.openAgents');
    await waitFor(managerOpen);
    await vscode.commands.executeCommand('hydra.toggleMode');
    await waitFor(() => !managerOpen());
    assert.deepEqual(await Promise.all(vscode.window.terminals.filter(item => item.name.startsWith('Hydra · ')).map(item => item.processId)), pids);
    await vscode.commands.executeCommand('hydra.stopTask', tasks[0]!.id);
    await waitFor(async () => (await vscode.commands.executeCommand<Task[]>('hydra.listTasks'))?.find(task => task.id === tasks[0]!.id)?.state === 'interrupted');
    await vscode.commands.executeCommand('hydra.launchTask', tasks[2]!.id);
    await waitFor(() => correctCwd(tasks[2]!));
    console.log('PASS: both provider routes launch in exact worktrees, reuse terminals, enforce the two-terminal limit, and survive mode changes.');
  }
}
