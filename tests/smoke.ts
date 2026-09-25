import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Handoff, HandoffTask, ProviderDiagnostic } from '../src/core/model';
import { createPlan, type Plan } from '../src/core/plans';
import { createWorktree } from '../src/core/worktrees';
import { createHandoffWorkspace, officialProviders } from '../src/core/handoff';
import type { ProfileResources } from '../src/core/profileImport';
import type { QuotaState } from '../src/core/quota';
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the VS Code tab state.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const managerOpen = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Agents');
const tabIdentity = (tab: vscode.Tab, column: vscode.ViewColumn): string => {
  const input = tab.input;
  const resource = input instanceof vscode.TabInputTextDiff ? ['diff', input.original.toString(), input.modified.toString()]
    : input instanceof vscode.TabInputText ? ['text', input.uri.toString()] : ['other'];
  return JSON.stringify([column, tab.label, ...resource]);
};
const hydraTerminals = () => vscode.window.terminals.filter(item => item.name.startsWith('Hydra · '));
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
    assert.deepEqual(await vscode.commands.executeCommand('hydra.listHelpers'), [], 'A handoff window starts no Hydra heads');
    assert.equal(hydraTerminals().length, 0);
    console.log(`PASS: ${provider} handoff loads the exact native workspace, presents instructions, and fails safely without an enabled provider.`);
    return;
  }
  if (process.env.HYDRA_TEST_RECOVERY === '1') {
    assert.equal(hydraTerminals().length, 0, 'A restart launches no provider');
    assert.equal((await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.status, 'unchecked', 'Quota observations are transient and never auto-refreshed on restart');
    assert.deepEqual(await vscode.commands.executeCommand('hydra.getProviderDiagnostics'), [], 'Provider checks are transient and never rerun on restart');
    assert.equal(managerOpen(), false, 'A restart opens the Editor, not the Agents view');
    console.log('PASS: a fresh host restarts without launching a provider, refreshing quota, or rerunning provider checks.');
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
      await waitFor(() => !managerOpen() && vscode.window.activeTextEditor?.document === document &&
        vscode.window.activeTextEditor.selection.start.character === 2 &&
        vscode.window.activeTextEditor.selection.end.character === 6);
      assert.equal(vscode.window.activeTextEditor?.document, document, 'Editor focus is restored');
      assert.equal(vscode.window.activeTextEditor?.selection.start.character, 2);
      assert.equal(vscode.window.activeTextEditor?.selection.end.character, 6);
      assert.equal(await terminal.processId, processId, 'The terminal process is preserved');
      assert.ok(vscode.window.terminals.includes(terminal));
      assert.ok(!managerOpen(), 'Manager leaves the editor surface');
    }
    console.log('PASS: three mode cycles preserve unsaved text, selection, focus, and a live terminal process.');
    assert.ok(!(await vscode.commands.getCommands(true)).includes('hydra.conversation.focus'), 'The task-era conversation view is gone');
    const preservedUri = vscode.Uri.file(path.join(repository!, 'keep.txt'));
    await vscode.commands.executeCommand('vscode.diff', preservedUri, preservedUri, 'Hydra mode diff preservation', { viewColumn: vscode.ViewColumn.Beside, preview: false });
    await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
    const diffTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
    const diffIdentity = tabIdentity(diffTab, vscode.window.tabGroups.activeTabGroup.viewColumn);
    const groupCount = vscode.window.tabGroups.all.length;
    const nativeTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tabIdentity(tab, group.viewColumn)));
    await vscode.commands.executeCommand('hydra.openAgents');
    await waitFor(managerOpen);
    await vscode.commands.executeCommand('hydra.toggleMode');
    await waitFor(() => {
      const group = vscode.window.tabGroups.activeTabGroup;
      return !managerOpen() && !!group.activeTab && tabIdentity(group.activeTab, group.viewColumn) === diffIdentity;
    }).catch(error => {
      console.error('Expected restored diff:', diffIdentity, 'Actual groups:', vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn, active: group.isActive, tabs: group.tabs.map(tab => ({ identity: tabIdentity(tab, group.viewColumn), active: tab.isActive })) })));
      throw error;
    });
    assert.equal(vscode.window.tabGroups.all.length, groupCount, 'Mode switches preserve split groups');
    const restoredTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tabIdentity(tab, group.viewColumn)));
    assert.deepEqual(restoredTabs.sort(), nativeTabs.sort(), 'Mode switches preserve native tab resources, labels, and groups including the diff');
    assert.equal(await terminal.processId, processId);
    assert.equal(hydraTerminals().length, 0, 'Mode switches make no provider launch');
    await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab!);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    console.log('PASS: mode switches preserve native diff tabs, split groups, and terminal processes without launching a provider.');
    const workbench = vscode.workspace.getConfiguration('workbench');
    const windowConfig = vscode.workspace.getConfiguration('window');
    const previousTheme = workbench.inspect<string>('colorTheme')?.globalValue;
    const previousAutomatic = windowConfig.inspect<boolean>('autoDetectColorScheme')?.globalValue;
    try {
      await vscode.commands.executeCommand('hydra.openAgents');
      await vscode.commands.executeCommand('hydra.openSettings');
      await vscode.commands.executeCommand('hydra.openSettings');
      const settingsTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra Settings');
      await waitFor(() => settingsTabs().length === 1);
      assert.ok(managerOpen(), 'Settings retains the agent-manager tab');
      const headsBeforeAppearance = await vscode.commands.executeCommand('hydra.listHelpers');
      for (const mode of ['light', 'dark'] as const) {
        await vscode.commands.executeCommand('hydra.setAppearance', mode);
        await waitFor(() => vscode.window.activeColorTheme.kind === (mode === 'light' ? vscode.ColorThemeKind.Light : vscode.ColorThemeKind.Dark));
        assert.equal(vscode.workspace.getConfiguration('workbench').get('colorTheme'), mode === 'light' ? 'Hydra Light' : 'Hydra Dark');
        assert.equal(vscode.workspace.getConfiguration('window').get('autoDetectColorScheme'), false);
        assert.equal(document.getText(), 'unsaved buffer\nkeep this selection\n');
        assert.equal(document.isClosed, false, 'Appearance preserves unsaved documents');
        assert.equal(await terminal.processId, processId, 'Appearance preserves the terminal process');
        assert.deepEqual(await vscode.commands.executeCommand('hydra.listHelpers'), headsBeforeAppearance, 'Appearance does not mutate head records');
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
      console.log('PASS: native Settings reuse, dark/light themes, override refusal, and unchanged unsaved buffers, terminal process, and head records.');
    } finally {
      await workbench.update('colorTheme', previousTheme, vscode.ConfigurationTarget.Global);
      await windowConfig.update('autoDetectColorScheme', previousAutomatic, vscode.ConfigurationTarget.Global);
    }
    const hydraConfig = vscode.workspace.getConfiguration('hydra');
    const previousChatLocation = hydraConfig.inspect<string>('chatLocation')?.globalValue;
    try {
      for (const mode of ['tabs', 'docked'] as const) {
        await vscode.commands.executeCommand('hydra.setChatLocation', mode);
        await waitFor(() => vscode.workspace.getConfiguration('hydra').get('chatLocation') === mode);
      }
      console.log('PASS: hydra.setChatLocation writes the global hydra.chatLocation preference.');
    } finally { await hydraConfig.update('chatLocation', previousChatLocation, vscode.ConfigurationTarget.Global); }
  } finally { terminal.dispose(); }
  {
    // Planner (docs/Lanes_And_Planner_Plan.md, section 4): a plan with a dependency
    // cycle is refused, with the cycle named, before anything is started.
    const cyclic: Plan = { ...createPlan({ title: 'Cyclic plan' }), jobs: [
      { key: 'api', title: 'API', brief: 'Build the API.', dependsOn: ['ui'] },
      { key: 'ui', title: 'UI', brief: 'Build the UI.', dependsOn: ['api'] },
    ] };
    const saved = await vscode.commands.executeCommand<Plan>('hydra.plans.save', cyclic);
    assert.equal(saved.id, cyclic.id, 'a plan with a cycle still saves: drawing one is allowed');
    await assert.rejects(async () => vscode.commands.executeCommand('hydra.plans.run', cyclic.id), /dependency cycle: API.*UI.*API/s);
    assert.deepEqual((await vscode.commands.executeCommand<Plan[]>('hydra.plans.list')).find(plan => plan.id === cyclic.id)?.state, 'draft', 'a refused run leaves the plan as it was');
    console.log('PASS: hydra.plans.run refuses a plan with a dependency cycle, naming it, and starts nothing.');
  }
  if (process.env.HYDRA_TEST_DESKTOP) {
    const accountsBefore = await vscode.commands.executeCommand<Record<string,{status:string}>>('hydra.getAccountSetupState');
    assert.equal(accountsBefore?.claude?.status,'unchecked'); assert.equal(accountsBefore?.codex?.status,'unchecked');
    await vscode.commands.executeCommand('hydra.openAccounts');
    await vscode.commands.executeCommand('hydra.openAccounts');
    const accountTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Accounts');
    await waitFor(() => accountTabs().length === 1);
    assert.deepEqual(await vscode.commands.executeCommand('hydra.getAccountSetupState'),accountsBefore,'Opening account setup is passive and never probes or starts sign-in');
    await vscode.window.tabGroups.close(accountTabs());
    assert.equal(document.isClosed,false,'Account setup preserves dirty editor documents');
    console.log('PASS: native provider account panel reuses one tab and opening it leaves provider state unchecked.');
    const setupTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Welcome to Hydra');
    assert.equal(setupTabs().length, 0, 'A built-in extension must not auto-open onboarding in an extension test host');
    const startup = await vscode.commands.executeCommand<{ development: boolean }>('hydra.desktop.startupContext');
    assert.equal(startup?.development, true, 'Owned workbench recognizes the separate native test harness');
    const setupBefore = await vscode.commands.executeCommand('hydra.getOnboardingState');
    await vscode.commands.executeCommand('hydra.openOnboarding');
    await vscode.commands.executeCommand('hydra.openOnboarding');
    await waitFor(() => setupTabs().length === 1);
    await vscode.window.tabGroups.close(setupTabs());
    assert.deepEqual(await vscode.commands.executeCommand('hydra.getOnboardingState'), setupBefore, 'Closing setup preserves the interrupted step');
    await vscode.commands.executeCommand('hydra.openOnboarding');
    await waitFor(() => setupTabs().length === 1);
    await vscode.window.tabGroups.close(setupTabs());
    assert.equal(document.isClosed, false, 'Reopening setup preserves dirty editor documents');
    console.log('PASS: native onboarding suppresses first-run in test hosts, reuses one tab, reopens its interrupted state, and preserves dirty documents.');
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
    const diagnostic = await vscode.commands.executeCommand<ProviderDiagnostic>('hydra.checkProvider', 'claude');
    assert.equal(diagnostic?.status, 'checked'); assert.equal(diagnostic.version, '2.1.270');
    const probeCalls = (await readFile(path.join(repository, 'hydra-probes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(probeCalls, [['--version'], ['--help']], 'Capability checks do not start a session or submit a prompt');
    assert.equal(hydraTerminals().length, 0, 'Checks do not launch provider terminals');
    console.log('PASS: explicit capability checks read only version/help and retain advertised options without starting a session.');
    // Handoff windows open one exact worktree with its descriptor (see scripts/smoke.mjs).
    const worktree = await createWorktree(repository, 'Handoff fixture', 'abcdefabcdef');
    const handoffTask: HandoffTask = { id: 'abcdefabcdef', title: 'Handoff fixture', prompt: 'Keep "quotes", Unicode ü, and $(literal text).', repository, worktree: worktree.worktree, branch: worktree.branch, baseCommit: worktree.baseCommit, provider: 'claude' };
    await mkdir(process.env.HYDRA_TEST_FIXTURE!, { recursive: true });
    const workspaces = await Promise.all((['claude', 'codex'] as const).map(provider => createHandoffWorkspace(path.join(process.env.HYDRA_TEST_FIXTURE!, 'handoffs'), handoffTask, provider)));
    await writeFile(path.join(process.env.HYDRA_TEST_FIXTURE!, 'handoffs.json'), JSON.stringify(workspaces));
    if (process.env.HYDRA_TEST_DESKTOP) {
      const quotasBefore = await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState');
      const headsBeforeQuota = await vscode.commands.executeCommand('hydra.listHelpers');
      await vscode.commands.executeCommand('hydra.openQuotaStatus');
      await waitFor(() => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Usage limits'));
      await vscode.commands.executeCommand('hydra.openQuotaStatus');
      assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'Hydra · Usage limits').length, 1);
      assert.deepEqual(await vscode.commands.executeCommand('hydra.getQuotaState'), quotasBefore, 'Opening and reopening quota view are passive');
      await vscode.commands.executeCommand('hydra.refreshQuota');
      const quotas = await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'); assert.ok(quotas);
      assert.equal(quotas.status, 'checked'); assert.equal(quotas.snapshot?.buckets[0]?.primary?.remainingPercent, 75);
      assert.equal(quotas.snapshot?.buckets[0]?.secondary, undefined); assert.equal(quotas.snapshot?.ordinaryUsageAllowed, undefined);
      assert.ok(!JSON.stringify(quotas).includes('private-fixture-account')); assert.ok(!JSON.stringify(quotas).includes('private-reset-token'));
      assert.deepEqual(await vscode.commands.executeCommand('hydra.listHelpers'), headsBeforeQuota); assert.equal(hydraTerminals().length, 0, 'Quota refresh starts no provider terminal');
      await vscode.workspace.getConfiguration('hydra').update('codexPath', 'relative-invalid-quota', vscode.ConfigurationTarget.Workspace);
      await waitFor(async () => (await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.status === 'unchecked');
      assert.equal((await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.snapshot, undefined);
      await vscode.commands.executeCommand('hydra.refreshQuota'); assert.equal((await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.status, 'error');
      await vscode.workspace.getConfiguration('hydra').update('codexPath', process.env.HYDRA_TEST_CODEX_PROVIDER, vscode.ConfigurationTarget.Workspace);
      await waitFor(async () => (await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.status === 'unchecked');
      console.log('PASS: native quota view is passive/reused, explicitly refreshes reported windows, strips identities/reset tokens, preserves head records, starts no provider terminal and clears observations on provider configuration changes.');
    } else {
      await assert.rejects(async () => vscode.commands.executeCommand('hydra.openQuotaStatus'), /local Hydra desktop IDE/);
      await assert.rejects(async () => vscode.commands.executeCommand('hydra.refreshQuota'), /trusted local Hydra window/);
      assert.equal((await vscode.commands.executeCommand<QuotaState>('hydra.getQuotaState'))?.status, 'unchecked');
      assert.equal(hydraTerminals().length, 0, 'Rejected quota commands start no provider terminal');
      console.log('PASS: bundled extension host refuses desktop-only quota commands without refreshing state or starting a provider turn.');
    }
  }
}
