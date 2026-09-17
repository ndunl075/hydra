import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Handoff, Task, ProviderDiagnostic, SessionView, TaskFile, DiffLayer } from '../src/core/model';
import { git } from '../src/core/worktrees';
import { createHandoffWorkspace, officialProviders } from '../src/core/handoff';
import type { ProfileResources } from '../src/core/profileImport';
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
  if (process.env.HYDRA_TEST_DESKTOP) {
    assert.equal(vscode.env.appName, 'Hydra', 'The host is Hydra itself');
    const bundled = path.join(path.dirname(process.env.HYDRA_TEST_DESKTOP), 'resources', 'app', 'extensions', 'hydra-agent-manager');
    assert.equal(path.relative(await realpath(bundled), await realpath(extension.extensionPath)), '', 'Hydra features load from the app bundle rather than the source checkout');
  }
  await extension.activate();
  const repository = process.env.HYDRA_TEST_REPOSITORY;
  if (process.env.HYDRA_TEST_HANDOFF_PROVIDER) {
    const provider = process.env.HYDRA_TEST_HANDOFF_PROVIDER as 'claude' | 'codex';
    const handoff = await vscode.commands.executeCommand<Handoff>('hydra.getHandoff');
    assert.ok(handoff);
    assert.equal(handoff.task.provider, provider);
    assert.equal(handoff.task.repository, repository);
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(path.relative(await realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath), await realpath(handoff.task.worktree)), '');
    assert.equal(await readFile(path.join(handoff.task.worktree, 'keep.txt'), 'utf8'), 'base\n');
    await waitFor(managerOpen);
    assert.equal(vscode.extensions.getExtension(officialProviders[provider].extensionId), undefined, 'Provider extensions are disabled for the smoke test');
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.openOfficialExtension'), /not enabled/);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.createTask', { repository: handoff.task.worktree, title: 'Blocked', prompt: 'Blocked', provider }), /original Hydra window/);
    assert.ok(!vscode.window.terminals.some(item => item.name.startsWith('Hydra · ')));
    console.log(`PASS: ${provider} handoff loads the exact native workspace, presents instructions, and fails safely without an enabled provider.`);
    return;
  }
  if (process.env.HYDRA_TEST_RECOVERY === '1') {
    const tasks = await vscode.commands.executeCommand<Task[]>('hydra.listTasks');
    assert.equal(tasks?.length, 3, 'All three task records are recovered');
    assert.ok(tasks.every(task => task.repository === repository && ['idle', 'interrupted'].includes(task.state)), 'No lost terminal is marked completed or running');
    for (const task of tasks) assert.equal((await readFile(path.join(task.worktree, 'keep.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'base\n');
    assert.ok(!vscode.window.terminals.some(terminal => terminal.name.startsWith('Hydra · ')), 'Recovery does not relaunch providers automatically');
    const managedTask = tasks.find(task => task.interface === 'managed-cli' && task.provider === 'claude');
    assert.ok(managedTask?.sessionId, 'Managed session identity survives reload');
    const session = await vscode.commands.executeCommand<SessionView>('hydra.getSession', managedTask.id);
    assert.equal(session?.turns.length, 2);
    assert.equal(session.turns[0]?.text, 'Hello ü');
    assert.equal(session.turns[1]?.status, 'interrupted');
    const codexTask = tasks.find(task => task.interface === 'managed-cli' && task.provider === 'codex');
    assert.ok(codexTask?.sessionId); assert.equal(codexTask.sessionProvider, 'codex');
    const codexSession = await vscode.commands.executeCommand<SessionView>('hydra.getSession', codexTask.id);
    assert.equal(codexSession?.turns.length, 3); assert.equal(codexSession.turns[0]?.text, 'Codex ü complete');
    assert.equal(codexSession.turns[2]?.status, 'interrupted'); assert.equal(codexSession.approvals, undefined);
    const workspaces = await Promise.all((['claude', 'codex'] as const).map((provider, index) => createHandoffWorkspace(path.join(process.env.HYDRA_TEST_FIXTURE!, 'handoffs'), tasks[index]!, provider)));
    await writeFile(path.join(process.env.HYDRA_TEST_FIXTURE!, 'handoffs.json'), JSON.stringify(workspaces));
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
    const workbench = vscode.workspace.getConfiguration('workbench');
    const windowConfig = vscode.workspace.getConfiguration('window');
    const previousTheme = workbench.inspect<string>('colorTheme')?.globalValue;
    const previousAutomatic = windowConfig.inspect<boolean>('autoDetectColorScheme')?.globalValue;
    try {
      await vscode.commands.executeCommand('hydra.openAgents');
      await vscode.commands.executeCommand('hydra.openSettings');
      await vscode.commands.executeCommand('hydra.openSettings');
      const settingsTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Settings');
      await waitFor(() => settingsTabs().length === 1);
      assert.ok(managerOpen(), 'Settings retains the agent-manager tab');
      const tasksBeforeAppearance = await vscode.commands.executeCommand<Task[]>('hydra.listTasks');
      for (const mode of ['light', 'dark'] as const) {
        await vscode.commands.executeCommand('hydra.setAppearance', mode);
        await waitFor(() => vscode.window.activeColorTheme.kind === (mode === 'light' ? vscode.ColorThemeKind.Light : vscode.ColorThemeKind.Dark));
        assert.equal(vscode.workspace.getConfiguration('workbench').get('colorTheme'), mode === 'light' ? 'Hydra Light' : 'Hydra Dark');
        assert.equal(vscode.workspace.getConfiguration('window').get('autoDetectColorScheme'), false);
        assert.equal(document.getText(), 'unsaved buffer\nkeep this selection\n');
        assert.equal(document.isClosed, false, 'Appearance preserves unsaved documents');
        assert.equal(await terminal.processId, processId, 'Appearance preserves the terminal process');
        assert.deepEqual(await vscode.commands.executeCommand('hydra.listTasks'), tasksBeforeAppearance, 'Appearance does not mutate task/session records');
      }
      await assert.rejects(async () => await vscode.commands.executeCommand('hydra.setAppearance', 'unknown'), /Unknown appearance/);
      await workbench.update('colorTheme', 'Hydra Dark', vscode.ConfigurationTarget.Workspace);
      try {
        await assert.rejects(async () => await vscode.commands.executeCommand('hydra.setAppearance', 'light'), /workspace overrides/);
        assert.equal(vscode.workspace.getConfiguration('workbench').inspect<string>('colorTheme')?.globalValue, 'Hydra Dark', 'Override refusal leaves global preferences untouched');
      } finally { await workbench.update('colorTheme', undefined, vscode.ConfigurationTarget.Workspace); }
      await vscode.window.tabGroups.close(settingsTabs());
      await vscode.commands.executeCommand('hydra.toggleMode');
      await waitFor(() => !managerOpen() && vscode.window.activeTextEditor?.document === document);
      console.log('PASS: native Settings reuse, dark/light themes, override refusal, and unchanged unsaved buffers, terminal process, and task records.');
    } finally {
      await workbench.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
      await windowConfig.update('autoDetectColorScheme', previousAutomatic, vscode.ConfigurationTarget.Global);
    }
  } finally { terminal.dispose(); }
  if (process.env.HYDRA_TEST_DESKTOP) {
    const profile = await vscode.commands.executeCommand<ProfileResources>('hydra.desktop.profileResources');
    assert.ok(profile); assert.equal(profile.name, 'Hydra Native Acceptance');
    assert.notEqual(path.dirname(profile.settings), profile.root, 'Native acceptance uses a named profile rather than inferring paths from global storage');
    const defaultSettings = path.join(profile.root, 'settings.json');
    const defaultBefore = await readFile(defaultSettings).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const source = path.join(process.env.HYDRA_TEST_FIXTURE!, 'Cursor preferences'); await mkdir(path.join(source, 'snippets'), { recursive: true });
    const sourceText = '// Imported preferences\n{"editor.fontSize":25,"editor.tabSize":3,"cursor.unavailable":true,"sample.apiKey":"never-copy","hydra.handoff":{"version":1}}\n';
    await writeFile(path.join(source, 'settings.json'), sourceText);
    await writeFile(path.join(source, 'keybindings.json'), '[{"key":"ctrl+alt+shift+9","command":"workbench.action.files.save"}]');
    await writeFile(path.join(source, 'snippets', 'typescript.json'), '{"Hydra Test":{"prefix":"hydra-test","body":"test $0"}}');
    const preview = await vscode.commands.executeCommand<{ token: string; items: { name: string; state: string }[] }>('hydra.previewImport', source); assert.ok(preview);
    assert.ok(preview.items.some(item => item.name === 'cursor.unavailable' && item.state === 'skip'));
    assert.ok(preview.items.some(item => item.name === 'hydra.handoff' && item.state === 'skip'));
    const preferenceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(profile.settings));
    await vscode.window.showTextDocument(preferenceDocument);
    const pending = new vscode.WorkspaceEdit(); pending.insert(preferenceDocument.uri, new vscode.Position(0, 0), '// Unsaved preferences\n'); assert.equal(await vscode.workspace.applyEdit(pending), true);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.applyImport', preview.token, ['settings']), /unsaved preference/);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.equal(await vscode.commands.executeCommand('hydra.applyImport', preview.token, ['settings', 'keybindings', 'snippets']), 3);
    assert.equal(vscode.workspace.getConfiguration('hydra').inspect('handoff')?.globalValue, undefined);
    await waitFor(() => vscode.workspace.getConfiguration('editor').inspect<number>('fontSize')?.globalValue === 25);
    assert.equal(await readFile(path.join(source, 'settings.json'), 'utf8'), sourceText);
    assert.equal(await readFile(path.join(profile.snippets, 'typescript.json'), 'utf8').then(text => text.includes('Hydra Test')), true);
    await vscode.commands.executeCommand('hydra.undoImport');
    await waitFor(() => vscode.workspace.getConfiguration('editor').inspect<number>('fontSize')?.globalValue === undefined);
    assert.deepEqual(await readFile(defaultSettings).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), defaultBefore);
    assert.equal(document.isClosed, false); assert.equal(document.getText(), 'unsaved buffer\nkeep this selection\n');
    console.log('PASS: native named-profile import, credential/unavailable-setting skips, unsaved-preference refusal, configuration reload, undo, and unchanged default profile/source/unsaved text.');
  } else {
    const importStatus = await vscode.commands.executeCommand<{ available: boolean }>('hydra.getImportStatus'); assert.equal(importStatus?.available, false);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.previewImport', path.join(process.env.HYDRA_TEST_FIXTURE!, 'not-a-profile')), /local Hydra desktop/);
    console.log('PASS: importing is unavailable in the VS Code development host.');
  }
  if (repository && process.env.HYDRA_TEST_PROVIDER) {
    const config = vscode.workspace.getConfiguration('hydra');
    await config.update('claudePath', process.env.HYDRA_TEST_PROVIDER, vscode.ConfigurationTarget.Workspace);
    await config.update('codexPath', process.env.HYDRA_TEST_CODEX_PROVIDER, vscode.ConfigurationTarget.Workspace);
    await config.update('maxConcurrentTasks', 2, vscode.ConfigurationTarget.Workspace);
    const diagnostic = await vscode.commands.executeCommand<ProviderDiagnostic>('hydra.checkProvider', 'claude');
    assert.equal(diagnostic?.status, 'checked'); assert.equal(diagnostic.version, '2.1.270');
    const probeCalls = (await readFile(path.join(repository, 'hydra-probes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(probeCalls, [['--version'], ['--help']], 'Capability checks do not start a session or submit a prompt');
    assert.ok(!vscode.window.terminals.some(item => item.name.startsWith('Hydra · ')), 'Checks do not launch provider terminals');
    console.log('PASS: explicit capability checks read only version/help and retain advertised options without claiming managed-session support.');
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
    for (const task of tasks.slice(1)) await vscode.commands.executeCommand('hydra.stopTask', task.id);
    await waitFor(async () => (await vscode.commands.executeCommand<Task[]>('hydra.listTasks'))?.every(task => task.state === 'interrupted') || false);
    await vscode.commands.executeCommand('hydra.startManaged', tasks[0]!.id);
    await waitFor(async () => { const session = await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[0]!.id); return session?.turns[0]?.status === 'completed' && !session.active; });
    const completed = await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[0]!.id);
    assert.equal(completed?.turns[0]?.text, 'Hello ü');
    assert.equal(completed.turns[0]?.usage?.input, 12);
    await vscode.commands.executeCommand('hydra.followUp', tasks[0]!.id, 'hold');
    await waitFor(async () => { try { await readFile(path.join(tasks[0]!.worktree, 'heartbeat.txt')); return true; } catch { return false; } });
    const requests = (await readFile(path.join(tasks[0]!.worktree, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].args[requests[1].args.indexOf('--resume') + 1], '12345678-1234-1234-1234-123456789abc');
    assert.equal(path.relative(await realpath(requests[0].cwd), await realpath(tasks[0]!.worktree)), '');
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.launchTask', tasks[0]!.id), /managed process/);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.handoffCodex', tasks[0]!.id), /managed process/);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.openDiff', tasks[0]!.id, 'keep.txt', 'combined'), /Stop this task writer/);
    await vscode.commands.executeCommand('hydra.launchTask', tasks[1]!.id);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.launchTask', tasks[2]!.id), /limit/);
    await vscode.commands.executeCommand('hydra.stopTask', tasks[0]!.id);
    assert.equal((await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[0]!.id))?.turns[1]?.status, 'interrupted');
    await vscode.commands.executeCommand('hydra.launchTask', tasks[2]!.id);
    console.log('PASS: managed Claude streams and persists a result, resumes its explicit ID, blocks overlapping writers, shares concurrency with terminals, and stops without inventing completion.');
    for (const task of tasks.slice(1)) await vscode.commands.executeCommand('hydra.stopTask', task.id);
    await waitFor(async () => (await vscode.commands.executeCommand<Task[]>('hydra.listTasks'))?.every(task => task.state === 'interrupted') || false);
    await vscode.commands.executeCommand('hydra.startManaged', tasks[1]!.id);
    await waitFor(async () => { const session = await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id); return session?.turns[0]?.status === 'completed' && !session.active; });
    assert.equal((await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id))?.turns[0]?.text, 'Codex ü complete');
    await vscode.commands.executeCommand('hydra.followUp', tasks[1]!.id, 'approval');
    await waitFor(async () => !!(await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id))?.approvals?.length);
    const pending = await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id);
    const approvalId = pending!.approvals![0]!.id;
    await vscode.commands.executeCommand('hydra.approve', tasks[1]!.id, approvalId, 'accept');
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.approve', tasks[1]!.id, approvalId, 'accept'), /no longer pending|No active/);
    await waitFor(async () => { const session = await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id); return session?.turns[1]?.status === 'completed' && !session.active; });
    await vscode.commands.executeCommand('hydra.followUp', tasks[1]!.id, 'hold');
    await waitFor(async () => (await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id))?.turns[2]?.text === 'Streaming ü');
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.launchTask', tasks[1]!.id), /managed process/);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.handoffClaude', tasks[1]!.id), /managed process/);
    await vscode.commands.executeCommand('hydra.launchTask', tasks[2]!.id);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.launchTask', tasks[0]!.id), /limit/);
    await vscode.commands.executeCommand('hydra.stopTask', tasks[1]!.id);
    await vscode.commands.executeCommand('hydra.stopTask', tasks[2]!.id);
    assert.equal((await vscode.commands.executeCommand<SessionView>('hydra.getSession', tasks[1]!.id))?.turns[2]?.status, 'interrupted');
    const codexRequests = (await readFile(path.join(tasks[1]!.worktree, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(codexRequests.find(message => message.method === 'thread/resume').params.threadId, '12345678-1234-7234-9234-123456789abc');
    assert.ok(codexRequests.find(message => message.method === 'turn/interrupt'));
    console.log('PASS: managed Codex streams, resumes its explicit thread, routes one approval, rejects stale approvals and overlapping writers, shares concurrency, and interrupts the active turn.');
    const reviewTask = tasks[2]!;
    const claudeRequestsBefore = await readFile(path.join(tasks[0]!.worktree, 'requests.jsonl'), 'utf8');
    const codexRequestsBefore = await readFile(path.join(tasks[1]!.worktree, 'codex-requests.jsonl'), 'utf8');
    await writeFile(path.join(reviewTask.worktree, 'review.txt'), 'committed review\n');
    await writeFile(path.join(reviewTask.worktree, 'old review.txt'), 'rename review\n');
    await writeFile(path.join(reviewTask.worktree, 'deleted review.txt'), 'deletion review\n');
    await git(reviewTask.worktree, ['add', 'review.txt', 'old review.txt', 'deleted review.txt']);
    await git(reviewTask.worktree, ['commit', '-m', 'review fixture']);
    await git(reviewTask.worktree, ['mv', 'old review.txt', 'renamed review ü.txt']);
    await writeFile(path.join(reviewTask.worktree, 'review.txt'), 'staged review\n'); await git(reviewTask.worktree, ['add', 'review.txt']);
    await writeFile(path.join(reviewTask.worktree, 'review.txt'), 'saved review\n');
    const fs = await import('node:fs/promises'); await fs.rm(path.join(reviewTask.worktree, 'deleted review.txt'));
    await writeFile(path.join(reviewTask.worktree, 'untracked review.txt'), 'untracked review\n');
    await writeFile(path.join(reviewTask.worktree, 'binary review.bin'), Buffer.from([0, 1, 255]));
    const editDocument = await vscode.workspace.openTextDocument(path.join(reviewTask.worktree, 'review.txt'));
    const unsaved = new vscode.WorkspaceEdit(); unsaved.insert(editDocument.uri, new vscode.Position(0, 0), 'unsaved editor change\n');
    assert.equal(await vscode.workspace.applyEdit(unsaved), true); assert.equal(editDocument.isDirty, true);
    const statusBefore = await git(reviewTask.worktree, ['status', '--porcelain=v1', '-z']);
    await vscode.commands.executeCommand('hydra.openAgents');
    const changes = await vscode.commands.executeCommand<TaskFile[]>('hydra.getChanges', reviewTask.id);
    assert.ok(changes?.find(file => file.path === 'review.txt')?.changes?.some(change => change.layer === 'staged'));
    for (const [file, layer, left, right] of [
      ['review.txt', 'combined', '', 'saved review\n'], ['review.txt', 'committed', '', 'committed review\n'],
      ['review.txt', 'staged', 'committed review\n', 'staged review\n'], ['review.txt', 'unstaged', 'staged review\n', 'saved review\n'],
      ['renamed review ü.txt', 'staged', 'rename review\n', 'rename review\n'], ['deleted review.txt', 'unstaged', 'deletion review\n', ''],
      ['untracked review.txt', 'untracked', '', 'untracked review\n']
    ] as [string, DiffLayer, string, string][]) {
      await vscode.commands.executeCommand('hydra.openDiff', reviewTask.id, file, layer);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff, 'Text changes open an actual native diff tab');
      assert.equal(input.original.scheme, 'hydra-review'); assert.equal(input.modified.scheme, 'hydra-review');
      assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), left);
      assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), right);
      assert.ok(managerOpen(), 'Native review leaves the manager open');
      if (layer === 'unstaged' && file === 'review.txt') {
        await writeFile(path.join(reviewTask.worktree, 'review.txt'), 'later saved review\n');
        assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), right, 'Snapshot does not silently update after disk edits');
      }
    }
    await vscode.commands.executeCommand('hydra.openDiff', reviewTask.id, 'binary review.bin', 'untracked');
    const binaryInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(binaryInput instanceof vscode.TabInputText, 'Binary review opens a native metadata document instead of a text diff');
    assert.ok((await vscode.workspace.openTextDocument(binaryInput.uri)).getText().includes('No text diff generated'));
    assert.equal(editDocument.isDirty, true); assert.ok(editDocument.getText().startsWith('unsaved editor change\n'), 'Review preserves the unsaved live editor');
    assert.equal(await git(reviewTask.worktree, ['status', '--porcelain=v1', '-z']), statusBefore);
    assert.equal(await readFile(path.join(tasks[0]!.worktree, 'requests.jsonl'), 'utf8'), claudeRequestsBefore);
    assert.equal(await readFile(path.join(tasks[1]!.worktree, 'codex-requests.jsonl'), 'utf8'), codexRequestsBefore);
    await assert.rejects(async () => await vscode.commands.executeCommand('hydra.openDiff', reviewTask.id, '../../keep.txt', 'unstaged'), /relative/);
    console.log('PASS: native read-only diff tabs show committed/staged/unstaged/untracked/renamed/deleted snapshots, preserve dirty buffers, show binary metadata, and make zero provider requests.');
  }
}
