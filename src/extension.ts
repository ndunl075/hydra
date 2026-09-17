import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from './core/store';
import { OwnershipLock } from './core/ownership';
import { createWorktree, git, repositoryRoot, resolveTaskFile, isInside } from './core/worktrees';
import { captureReview, captureCommitReview, reviewFiles } from './core/review';
import { prepareCommitReview, commitReviewed } from './core/reviewCommit';
import { Integrations } from './core/integration';
import type { IntegrationOperation } from './core/integrationModel';
import { ReviewDocuments } from './extensionReview';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { findProvider, terminalLaunch } from './core/providers';
import { checkProvider } from './core/diagnostics';
import { ManagedSessions } from './core/managedSessions';
import { SessionStore } from './core/sessionStore';
import { testedClaudeVersion } from './core/claudeProtocol';
import { testedCodexVersion } from './core/codexProtocol';
import type { Provider, ProviderDiagnostic, PreparedReview, ReviewedCommit } from './core/model';
import { assertCliAllowed, handoffTask, parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { parseMessage, type Task, type Snapshot, type ProviderInfo, type Draft, type Handoff, type HandoffTask } from './core/model';

let manager: Manager | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  manager = new Manager(context);
  await manager.initialize();
  await manager.showFirstRun();
}
export async function deactivate(): Promise<void> { await manager?.shutdown(); }

class TaskTree implements vscode.TreeDataProvider<Task> {
  readonly changed = new vscode.EventEmitter<Task | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly tasks: () => Task[]) {}
  getTreeItem(task: Task): vscode.TreeItem {
    const item = new vscode.TreeItem(task.title);
    item.id = task.id;
    item.description = `${task.provider} · ${task.state}`;
    item.tooltip = `${task.branch}\n${task.worktree}`;
    item.iconPath = new vscode.ThemeIcon(task.state === 'external' ? 'terminal' : task.state === 'error' ? 'warning' : 'git-branch');
    item.command = { command: 'hydra.openTask', title: 'Open Task', arguments: [task.id] };
    return item;
  }
  getChildren(): Task[] { return this.tasks(); }
}

class Manager {
  private tasks: Task[] = [];
  private repositories: string[] = [];
  private providers: ProviderInfo[] = [];
  private panel?: vscode.WebviewPanel;
  private selectedId?: string;
  private mode: 'editor' | 'agents' = 'editor';
  private busy = false;
  private error?: string;
  private disabled = false;
  private closing = false;
  private draft?: Draft;
  private previousEditor?: { document: vscode.TextDocument; column: vscode.ViewColumn; selections: readonly vscode.Selection[]; range?: vscode.Range };
  private terminals = new Map<string, vscode.Terminal>();
  private readonly tree = new TaskTree(() => this.tasks);
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('Hydra');
  private readonly locks: OwnershipLock[] = [];
  private readonly store: LocalStore;
  private readonly storageDirectory: string;
  private snapshotGeneration = 0;
  private pendingNewTask = false;
  private handoff?: Handoff;
  private readonly diagnostics = new Map<Provider, ProviderDiagnostic>();
  private readonly diagnosticChecks = new Set<AbortController>();
  private diagnosticGeneration = 0;
  private readonly managed: ManagedSessions;
  private readonly review: ReviewDocuments;
  private readonly commitReviews = new Map<string, PreparedReview>();
  private pendingCommit?: Promise<ReviewedCommit>;
  private readonly integrations: Integrations;
  private readonly integrationOperations = new Map<string, IntegrationOperation>();
  private pendingIntegration?: Promise<unknown>;
  private integrationAbort?: { taskId: string; operationId?: string; controller: AbortController };
  private readonly settings: AppearanceSettings;
  private readonly settingsImport: SettingsImport;
  private readonly onboarding: Onboarding;
  private fileCache?: { id: string; expires: number; files: Snapshot['files']; error?: string };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsImport = new SettingsImport(context);
    this.settings = new AppearanceSettings(context.extensionUri, this.settingsImport);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings);
    context.subscriptions.push(this.settings, this.onboarding);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.store = new LocalStore(this.storageDirectory);
    this.integrations = new Integrations(path.join(this.storageDirectory,'integrations'),op=>{
      this.integrationOperations.set(op.taskId,op);
      if(this.integrationAbort?.taskId===op.taskId)this.integrationAbort.operationId=op.id;
      void this.publish();
    });
    this.review = new ReviewDocuments(context);
    this.managed = new ManagedSessions(new SessionStore(path.join(this.storageDirectory, 'sessions')), () => this.persist(), () => { void this.publish(); }, error => this.report(error));
  }
  async initialize(): Promise<void> {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, (...args) =>
      Promise.resolve().then(() => callback(...args)).catch(error => { this.report(error); throw error; })));
    command('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    command('hydra.openAgents', () => this.openAgents());
    command('hydra.newTask', async () => { this.pendingNewTask = !this.panel; await this.openAgents(); await this.panel?.webview.postMessage({ type: 'newTask' }); });
    command('hydra.openTask', async (id: string) => { this.getTask(id); this.selectedId = id; await this.openAgents(); });
    command('hydra.refresh', () => this.refresh());
    command('hydra.openSettings', () => this.settings.show());
    command('hydra.openOnboarding', () => this.onboarding.show());
    command('hydra.getOnboardingState', () => this.onboarding.snapshot());
    command('hydra.setAppearance', (mode: 'dark' | 'light') => this.settings.setAppearance(mode));
    command('hydra.previewImport', (source: unknown) => { if (typeof source !== 'string') throw new Error('Choose a settings folder.'); return this.settingsImport.preview(source); });
    command('hydra.applyImport', (token: string, categories: any) => this.settingsImport.apply(token, categories));
    command('hydra.undoImport', () => this.settingsImport.undo());
    command('hydra.getImportStatus', () => this.settingsImport.status());
    command('hydra.createTask', async (input?: unknown) => {
      if (input === undefined) { this.pendingNewTask = !this.panel; await this.openAgents(); await this.panel?.webview.postMessage({ type: 'newTask' }); return; }
      if (!input || typeof input !== 'object') throw new Error('Expected task options.');
      await this.handle({ ...input, type: 'create' });
      return structuredClone(this.getTask(this.selectedId!));
    });
    command('hydra.launchTask', (id: string) => this.handle({ type: 'launch', id }));
    command('hydra.stopTask', (id: string) => this.handle({ type: 'stop', id }));
    command('hydra.listTasks', () => structuredClone(this.tasks));
    command('hydra.handoffClaude', (id?: string) => this.handoffCommand('claude', id));
    command('hydra.handoffCodex', (id?: string) => this.handoffCommand('codex', id));
    command('hydra.releaseExternal', (id: string) => this.handle({ type: 'releaseExternal', id }));
    command('hydra.openOfficialExtension', () => this.handle({ type: 'openOfficial' }));
    command('hydra.getHandoff', () => structuredClone(this.handoff));
    command('hydra.checkProvider', async (provider?: string) => {
      provider ||= vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude');
      await this.handle({ type: 'checkProvider', provider });
      return structuredClone(this.diagnostics.get(provider as Provider));
    });
    command('hydra.getProviderDiagnostics', () => structuredClone([...this.diagnostics.values()]));
    command('hydra.startManaged', (id: string) => this.handle({ type: 'startManaged', id }));
    command('hydra.followUp', (id: string, prompt: string) => this.handle({ type: 'followUp', id, prompt }));
    command('hydra.getSession', (id: string) => structuredClone(this.managed.view(id)));
    command('hydra.approve', (id: string, approvalId: string, decision: string) => this.handle({ type: 'approve', id, approvalId, decision }));
    command('hydra.openDiff', (id: string, filePath: string, layer: string) => this.handle({ type: 'openDiff', id, path: filePath, layer }));
    command('hydra.prepareCommitReview', async (id: string) => { await this.handle({ type: 'prepareCommitReview', id }); return structuredClone(this.commitReviews.get(id)); });
    command('hydra.openCommitReview', (id: string, token: string, filePath: string) => this.handle({ type: 'openCommitReview', id, token, path: filePath }));
    command('hydra.commitReviewed', async (id: string, token: string, message: string) => { await this.handle({ type: 'commitReviewed', id, token, message }); return structuredClone(this.getTask(id).reviewedCommit); });
    command('hydra.prepareIntegration',async(id:string,checks:unknown)=>{await this.handle({type:'prepareIntegration',id,checks});return structuredClone(this.integrationOperations.get(id));});
    command('hydra.getIntegration',(id:string)=>structuredClone(this.integrationOperations.get(this.getTask(id).id)));
    command('hydra.promoteIntegration',(id:string,operationId:string)=>this.handle({type:'promoteIntegration',id,operationId}));
    command('hydra.reviewIntegrationResolution',async(id:string,operationId:string)=>{await this.handle({type:'reviewIntegrationResolution',id,operationId});return structuredClone(this.integrationOperations.get(id));});
    command('hydra.acceptIntegrationResolution',(id:string,operationId:string,token:string)=>this.handle({type:'acceptIntegrationResolution',id,operationId,token}));
    command('hydra.openIntegrationDiff',(id:string,operationId:string,filePath:string)=>this.handle({type:'openIntegrationDiff',id,operationId,path:filePath}));
    command('hydra.getChanges', async (id: string) => { const task = this.getTask(id); if (!vscode.workspace.isTrusted || this.disabled) throw new Error('Task review requires a trusted, healthy workspace.'); await this.verifyWorktree(task); return reviewFiles(task.worktree, task.baseCommit); });
    this.context.subscriptions.push(vscode.window.registerTreeDataProvider('hydra.tasks', this.tree), this.tree.changed, this.status, this.output);
    this.status.command = 'hydra.toggleMode';
    this.status.show();
    this.context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      if (this.closing) return;
      for (const [id, owned] of this.terminals) {
        if (terminal !== owned) continue;
        this.terminals.delete(id);
        const task = this.getTask(id);
        task.state = 'interrupted';
        task.updatedAt = new Date().toISOString();
        void this.persist().catch(error => this.report(error));
      }
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('hydra')) {
        this.diagnosticGeneration++; this.diagnostics.clear();
        for (const controller of this.diagnosticChecks) controller.abort();
        void this.refresh().catch(error => this.report(error));
      }
    }));
    try {
      this.tasks = await this.store.load();
      await this.refreshRepositories();
      if (vscode.workspace.isTrusted) {
        // Lock each canonical repository, so different workspace configurations cannot own the same repo.
        for (const repository of [...new Set([...this.repositories, ...this.tasks.map(task => task.repository)])].sort()) {
          const lock = new OwnershipLock();
          await lock.acquire(path.join(this.context.globalStorageUri.fsPath, 'ownership'), repository);
          this.locks.push(lock);
        }
        for (const task of this.tasks) {
          if (task.state === 'running') task.state = 'interrupted';
          if (task.state === 'external' && task.interface === 'interactive-cli') task.state = 'interrupted';
          try { await this.verifyWorktree(task); }
          catch (error) { task.state = 'error'; task.error = this.describe(error); }
          if (task.interface === 'managed-cli' || task.sessionId) {
            try { await this.managed.load(task); }
            catch (error) { task.state = 'error'; task.error = this.describe(error); }
          }
        }
        await this.store.save(this.tasks);
        for(const op of await this.integrations.recover(this.tasks))this.integrationOperations.set(op.taskId,op);
      }
      this.selectedId = this.tasks[0]?.id;
      this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
    } catch (error) { this.disabled = true; this.report(error); }
    try { await this.refreshProviders(); }
    catch (error) { this.report(error); }
    try {
      this.handoff = parseHandoff(vscode.workspace.getConfiguration('hydra').get('handoff'));
      if (this.handoff) { await this.verifyHandoffWorkspace(); await this.openAgents(); }
    } catch (error) { this.disabled = true; this.report(error); }
    await this.publish();
  }
  async showFirstRun(): Promise<void> {
    if (!this.disabled) await this.onboarding.autoShow(!!vscode.workspace.getConfiguration('hydra').get('handoff'));
  }
  private async handoffCommand(provider: 'claude' | 'codex', id?: string): Promise<string | undefined> {
    if (!id) {
      const picked = await vscode.window.showQuickPick(this.tasks.map(task => ({ label: task.title, description: task.branch, id: task.id })), { title: `Open task in ${provider === 'claude' ? 'Claude Code' : 'Codex'}` });
      if (!picked) return;
      id = picked.id;
    }
    await this.handle({ type: 'handoff', id, provider });
    return path.join(this.context.globalStorageUri.fsPath, 'handoffs', `${id}-${provider}.code-workspace`);
  }
  private async verifyHandoffWorkspace(): Promise<void> {
    if (!this.handoff) throw new Error('Open the task handoff workspace to use this action.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || path.relative(await realpath(folders[0]!.uri.fsPath), await realpath(this.handoff.task.worktree)) !== '') throw new Error('Handoff workspace does not match the exact task worktree.');
    await this.verifyWorktree(this.handoff.task);
  }
  private async refreshRepositories(): Promise<void> {
    const repositories: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      try { repositories.push(await repositoryRoot(folder.uri.fsPath)); }
      catch { /* Non-Git folders remain ordinary editor workspaces. */ }
    }
    this.repositories = [...new Set(repositories)];
  }
  private async refreshProviders(): Promise<void> {
    const config = vscode.workspace.getConfiguration('hydra');
    this.providers = await Promise.all(['claude', 'codex'].map(provider => findProvider(provider as 'claude' | 'codex', config.get<string>(`${provider}Path`))));
  }
  private async refresh(): Promise<void> { this.error = undefined; this.fileCache = undefined; await this.refreshProviders(); await this.publish(); }
  private describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private report(error: unknown): void {
    this.error = this.describe(error);
    this.output.appendLine(this.error);
    void vscode.window.showErrorMessage(`Hydra: ${this.error}`);
    void this.publish();
  }
  private getTask(id: string): Task {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new Error('Task not found.');
    return task;
  }
  private async verifyWorktree(task: Pick<HandoffTask, 'repository' | 'worktree' | 'branch'>): Promise<void> {
    const actual = await realpath(task.worktree);
    if (actual !== await repositoryRoot(actual)) throw new Error('Saved worktree is not a repository root.');
    const [taskCommon, mainCommon, branch] = await Promise.all([
      git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(task.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(actual, ['symbolic-ref', '--short', 'HEAD'])
    ]);
    if (await realpath(taskCommon.trim()) !== await realpath(mainCommon.trim())) throw new Error('Task worktree belongs to a different repository.');
    if (branch.trim() !== task.branch) throw new Error('Task worktree branch changed. Restore its recorded branch before launching.');
  }
  private async persist(): Promise<void> { await this.store.save(this.tasks); await this.publish(); }
  private reviewBlocked(task: Task): boolean { return this.busy || this.closing || this.disabled || !vscode.workspace.isTrusted || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external'; }
  private async guardCommitReview(task: Task): Promise<void> {
    if (this.closing || this.disabled || !vscode.workspace.isTrusted || this.handoff || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension') throw new Error('Stop the task writer and acknowledge external handback before preparing a commit review.');
    const root = await realpath(task.worktree);
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const file = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
      if (isInside(root, file) || isInside(root, document.uri.fsPath)) throw new Error('Save or revert unsaved task editor buffers before preparing a commit review.');
    }
  }
  private async guardIntegration(task:Task,paths:string[]):Promise<void>{
    await this.guardCommitReview(task);
    for(const directory of paths){
      const root=await realpath(directory);
      for(const document of vscode.workspace.textDocuments){
        if(!document.isDirty||document.uri.scheme!=='file')continue;
        const file=await realpath(document.uri.fsPath).catch(()=>document.uri.fsPath);
        if(isInside(root,file)||isInside(root,document.uri.fsPath))throw new Error('Save or revert unsaved task, target, and candidate editor buffers before integration.');
      }
    }
    if(this.closing||this.disabled||!vscode.workspace.isTrusted)throw new Error('Integration cancelled because the workspace closed or lost trust.');
  }
  private async publish(): Promise<void> {
    const generation = ++this.snapshotGeneration;
    this.tree.changed.fire(undefined);
    const active = this.terminals.size + this.managed.count;
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agents' : 'Editor'}${active ? ` · ${active} active` : ''}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = 'Hydra: Switch Editor / Agents (Ctrl+Alt+A)';
    const task = this.tasks.find(item => item.id === this.selectedId);
    let files: Snapshot['files'] = [];
    let error = this.error;
    if (task && vscode.workspace.isTrusted) {
      if (this.fileCache?.id === task.id && this.fileCache.expires > Date.now()) { files = this.fileCache.files; error ||= this.fileCache.error; }
      else {
        try { await this.verifyWorktree(task); files = await reviewFiles(task.worktree, task.baseCommit); }
        catch (failure) { error = this.describe(failure); }
        this.fileCache = { id: task.id, expires: Date.now() + 1000, files, error };
      }
    }
    if (generation !== this.snapshotGeneration) return;
    const snapshot: Snapshot = {
      tasks: this.tasks, selectedId: this.selectedId, mode: this.mode, repositories: this.repositories,
      providers: this.providers, files, busy: this.busy || this.disabled, error, draft: this.draft,
      handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')),
      diagnostics: [...this.diagnostics.values()], session: task ? this.managed.displayView(task.id) : undefined,
      commitReview: task ? this.commitReviews.get(task.id) : undefined,
      integration: task ? this.integrationSnapshot(this.integrationOperations.get(task.id)) : undefined,
      taskActivity: Object.fromEntries(this.tasks.map(item => {
        const view = item.interface === 'managed-cli' ? this.managed.view(item.id) : undefined;
        return [item.id, { active: !!view?.active, awaitingApproval: !!view?.active && !!view.approvals?.length }];
      }))
    };
    await this.panel?.webview.postMessage({ type: 'snapshot', snapshot });
  }
  private integrationSnapshot(op?:IntegrationOperation):IntegrationOperation|undefined{
    return op?{...op,checks:op.checks.map(({stdout:_stdout,stderr:_stderr,...check})=>check)}:undefined;
  }
  private async openAgents(): Promise<void> {
    if (this.mode !== 'agents') {
      const editor = vscode.window.activeTextEditor;
      this.previousEditor = editor ? { document: editor.document, column: editor.viewColumn || vscode.ViewColumn.One, selections: editor.selections, range: editor.visibleRanges[0] } : undefined;
    }
    this.mode = 'agents';
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('hydra.manager', 'Hydra · Agents', vscode.ViewColumn.One, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
      });
      this.panel = panel;
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined;
        this.mode = 'editor';
        void this.publish();
      }, undefined, this.context.subscriptions);
      panel.webview.onDidReceiveMessage(value => {
        void this.handle(value).catch(error => this.report(error));
      }, undefined, this.context.subscriptions);
    } else this.panel.reveal(vscode.ViewColumn.One);
    await vscode.commands.executeCommand('workbench.view.extension.hydra');
    this.panel?.reveal(vscode.ViewColumn.One);
    await this.publish();
  }
  private async openEditor(): Promise<void> {
    this.mode = 'editor';
    this.panel?.dispose();
    await vscode.commands.executeCommand('workbench.view.explorer');
    const previous = this.previousEditor;
    if (previous && !previous.document.isClosed) {
      const editor = await vscode.window.showTextDocument(previous.document, { viewColumn: previous.column, preview: false });
      editor.selections = [...previous.selections];
      if (previous.range) editor.revealRange(previous.range, vscode.TextEditorRevealType.Default);
    }
    await this.publish();
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Hydra</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  private async handle(value: unknown): Promise<void> {
    const message = parseMessage(value);
    if (message.type === 'ready') { await this.publish(); if (this.pendingNewTask) { this.pendingNewTask = false; await this.panel?.webview.postMessage({ type: 'newTask' }); } return; }
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'settings') { this.settings.show(); return; }
    if (message.type === 'refresh') { this.error = undefined; await this.refresh(); return; }
    if (message.type === 'draft') { this.draft = { title: message.title, prompt: message.prompt, provider: message.provider }; return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use task worktrees and terminals.');
    if (this.disabled) throw new Error('Hydra task operations are disabled. Resolve the storage or ownership error and reload this window.');
    if (message.type === 'checkProvider' || message.type === 'showProviderDiagnostics') {
      if (message.type === 'showProviderDiagnostics') {
        const diagnostic = this.diagnostics.get(message.provider);
        if (!diagnostic) throw new Error('Check the provider first to collect diagnostics.');
        const document = await vscode.workspace.openTextDocument({ content: JSON.stringify(diagnostic, null, 2), language: 'json' });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
      if (this.diagnostics.get(message.provider)?.status === 'checking') throw new Error('This provider check is already in progress.');
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.diagnostics.set(message.provider, { provider: message.provider, status: 'checking', checkedAt: new Date().toISOString(), advertised: [], probes: [] });
      await this.publish();
      try {
        const info = await findProvider(message.provider, vscode.workspace.getConfiguration('hydra').get<string>(`${message.provider}Path`));
        const diagnostic = await checkProvider(info, this.repositories[0] || this.context.extensionUri.fsPath, controller.signal);
        if (generation === this.diagnosticGeneration && !this.closing) this.diagnostics.set(message.provider, diagnostic);
      } catch (error) {
        if (generation === this.diagnosticGeneration && !this.closing) this.diagnostics.set(message.provider, { provider: message.provider, status: 'error', checkedAt: new Date().toISOString(), advertised: [], probes: [], error: this.describe(error) });
      } finally { this.diagnosticChecks.delete(controller); await this.publish(); }
      return;
    }
    if (message.type === 'openOfficial' || message.type === 'showOfficial' || message.type === 'copyHandoffPrompt') {
      await this.verifyHandoffWorkspace();
      const handoff = this.handoff!;
      if (message.type === 'openOfficial') await openOfficialExtension(handoff.task.provider);
      else if (message.type === 'showOfficial') await vscode.commands.executeCommand('workbench.extensions.search', `@id:${officialProviders[handoff.task.provider].extensionId}`);
      else await vscode.env.clipboard.writeText(handoff.task.prompt);
      await this.publish();
      return;
    }
    if (this.handoff && ['create', 'handoff', 'launch', 'terminal', 'openWorktree', 'startManaged', 'followUp'].includes(message.type)) throw new Error('This window is an official-extension handoff. Manage task writers from the original Hydra window.');
    if (this.busy && ['create', 'handoff', 'launch', 'terminal', 'releaseExternal', 'startManaged', 'followUp', 'prepareCommitReview', 'commitReviewed','prepareIntegration','promoteIntegration','reviewIntegrationResolution','acceptIntegrationResolution'].includes(message.type)) throw new Error('Another task operation is in progress.');
    if (message.type === 'create') {
      if (this.busy) throw new Error('Another task operation is in progress.');
      if (!this.repositories.includes(message.repository)) throw new Error('Choose an open workspace repository.');
      this.busy = true;
      await this.publish();
      try {
        const id = randomBytes(6).toString('hex');
        const worktree = await createWorktree(message.repository, message.title, id, vscode.workspace.getConfiguration('hydra').get<string>('worktreeRoot'));
        const now = new Date().toISOString();
        this.tasks.push({ id, title: message.title.trim(), prompt: message.prompt.trim(), provider: message.provider,
          repository: message.repository, ...worktree, interface: 'interactive-cli', state: 'idle', createdAt: now, updatedAt: now });
        this.selectedId = id;
        this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
        await this.persist();
        await this.panel?.webview.postMessage({ type: 'taskCreated' });
      } finally { this.busy = false; await this.publish(); }
      return;
    }
    if (!('id' in message)) throw new Error('Expected a task command.');
    const task = this.getTask(message.id);
    if (message.type === 'select') { this.selectedId = task.id; await this.publish(); return; }
    if (message.type === 'copyPrompt') { await vscode.env.clipboard.writeText(task.prompt); void vscode.window.showInformationMessage('Task prompt copied. Paste it into the provider terminal when ready.'); return; }
    if (message.type === 'stop') {
      if (this.managed.has(task.id)) { await this.managed.stop(task.id); return; }
      if (this.busy && task.state === 'running') throw new Error('This process is still being prepared. Stop it once startup finishes.');
      const terminal = this.terminals.get(task.id);
      if (!terminal) return;
      terminal.dispose();
      return;
    }
    if (message.type === 'approve') { this.managed.approve(task.id, message.approvalId, message.decision); return; }
    if(message.type==='cancelIntegration'){
      if(this.integrationAbort?.taskId!==task.id||this.integrationAbort.operationId!==message.operationId)throw new Error('This integration has no active checks to cancel.');
      this.integrationAbort.controller.abort();return;
    }
    await this.verifyWorktree(task);
    if(message.type==='prepareIntegration'||message.type==='promoteIntegration'||message.type==='reviewIntegrationResolution'||message.type==='acceptIntegrationResolution'){
      if(this.busy)throw new Error('Another task operation is in progress.');
      this.busy=true;this.error=undefined;
      const controller=new AbortController();this.integrationAbort={taskId:task.id,controller};
      const action=async()=>{
        const guard=(paths:string[])=>this.guardIntegration(task,paths);
        if(message.type==='prepareIntegration'){await this.integrations.prepare(task,message.checks,guard,controller.signal);return;}
        const op=this.getIntegration(task,message.operationId);this.integrationAbort!.operationId=op.id;
        if(message.type==='promoteIntegration')await this.integrations.promote(task,op,guard);
        else if(message.type==='reviewIntegrationResolution')await this.integrations.reviewResolution(task,op,guard);
        else if(message.type==='acceptIntegrationResolution')await this.integrations.acceptResolution(task,op,message.token,guard,controller.signal);
      };
      this.pendingIntegration=action();
      try{await this.pendingIntegration;}finally{this.pendingIntegration=undefined;this.integrationAbort=undefined;this.busy=false;this.fileCache=undefined;await this.publish();}
      return;
    }
    if(message.type==='copyIntegrationCandidate'||message.type==='showIntegrationLog'||message.type==='openIntegrationDiff'){
      const op=this.getIntegration(task,message.operationId);
      if(message.type==='copyIntegrationCandidate'){await vscode.env.clipboard.writeText(op.candidate);return;}
      if(message.type==='showIntegrationLog'){await this.review.openLog(`${task.title} · Integration ${op.id}`,JSON.stringify(op,null,2));return;}
      if(message.type!=='openIntegrationDiff')return;
      if(this.reviewBlocked(task)||!op.candidateCommit||!op.candidateTree)throw new Error('Stop task writers and prepare a candidate review before opening its snapshots.');
      const prepared:PreparedReview={token:op.reviewToken||op.id,head:op.candidateCommit,tree:op.candidateTree,baseCommit:op.targetCommit,branch:op.targetBranch,indexHash:'',createdAt:op.updatedAt,files:op.files};
      const snapshot=await captureCommitReview(op.candidate,prepared,message.path);
      if(this.reviewBlocked(task))throw new Error('Task writer restarted. Stop it before reviewing the candidate.');
      await this.review.open(`${task.title} · Integration into ${op.targetBranch}`,op.candidate,snapshot);return;
    }
    if (this.busy && ['handoff', 'launch', 'terminal', 'releaseExternal', 'startManaged', 'followUp'].includes(message.type)) throw new Error('Another task operation is in progress.');
    if (message.type === 'prepareCommitReview' || message.type === 'commitReviewed') {
      if (this.busy) throw new Error('Another task operation is in progress.');
      this.busy = true;
      try {
        this.error = undefined;
        await this.guardCommitReview(task);
        if (message.type === 'prepareCommitReview') {
          this.commitReviews.delete(task.id);
          const prepared = await prepareCommitReview(task.worktree, task.baseCommit, task.branch);
          await this.guardCommitReview(task);
          this.commitReviews.set(task.id, prepared);
        } else {
          const prepared = this.commitReviews.get(task.id);
          if (!prepared || prepared.token !== message.token) throw new Error('Review expired. Prepare a fresh review.');
          this.commitReviews.delete(task.id);
          this.pendingCommit = commitReviewed(task.worktree, prepared, message.message, () => this.guardCommitReview(task));
          task.reviewedCommit = await this.pendingCommit;
          task.updatedAt = new Date().toISOString();
          await this.persist();
        }
      } finally { this.pendingCommit = undefined; this.fileCache = undefined; this.busy = false; await this.publish(); }
      return;
    }
    if (message.type === 'openCommitReview') {
      if (this.reviewBlocked(task)) throw new Error('Stop this task writer before reviewing changes.');
      const prepared = this.commitReviews.get(task.id);
      if (!prepared || prepared.token !== message.token) throw new Error('Review expired. Prepare a fresh review.');
      const snapshot = await captureCommitReview(task.worktree, prepared, message.path);
      if (this.reviewBlocked(task)) throw new Error('Stop this task writer before reviewing changes.');
      await this.review.open(`${task.title} · Prepared tree ${prepared.tree.slice(0, 8)}`, task.worktree, snapshot);
      return;
    }
    if (['startManaged', 'followUp', 'launch', 'terminal', 'handoff'].includes(message.type)) this.commitReviews.delete(task.id);
    if (message.type === 'showSessionDiagnostics') {
      const turn = this.managed.view(task.id)?.turns.at(-1);
      if (!turn) throw new Error('No managed turn diagnostics yet.');
      await vscode.window.showTextDocument(vscode.Uri.file(this.managed.store.rawPath(task.id, turn.id)), { viewColumn: vscode.ViewColumn.Beside, preview: true });
      return;
    }
    if (message.type === 'openDiff') {
      if (this.reviewBlocked(task)) throw new Error('Stop this task writer or acknowledge official-extension handback before reviewing changes.');
      const snapshot = await captureReview(task.worktree, task.baseCommit, message.path, message.layer);
      // A launch may finish its asynchronous checks while snapshot capture is in progress.
      if (this.reviewBlocked(task)) throw new Error('The task writer restarted. Stop it before reviewing changes.');
      await this.review.open(`${task.title} · ${task.branch}`, task.worktree, snapshot);
      return;
    }
    if (message.type === 'startManaged' || message.type === 'followUp') {
      assertCliAllowed(task);
      if (task.sessionId && task.sessionProvider !== task.provider) throw new Error('The recorded session belongs to another provider. Create a separate task for this provider.');
      if (this.terminals.has(task.id) || task.state === 'external' || this.managed.has(task.id)) throw new Error('Stop this task writer before starting a managed turn.');
      if (message.type === 'startManaged' && task.sessionId) throw new Error('This task already has a session. Send a follow-up to resume it.');
      if (message.type === 'followUp' && !task.sessionId) throw new Error('Start the task first before sending a follow-up.');
      const max = vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2);
      if (this.terminals.size + this.managed.count >= max) throw new Error('The task concurrency limit is reached. Stop a task writer first.');
      this.busy = true;
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      try {
        const info = await findProvider(task.provider, vscode.workspace.getConfiguration('hydra').get<string>(`${task.provider}Path`));
        if (!info.executable) throw new Error(`${task.provider} CLI not found. Set its executable path first.`);
        // Re-probe immediately before a model request: cached help must not authorize a changed binary.
        const diagnostic = await checkProvider(info, task.worktree, controller.signal);
        if (controller.signal.aborted || this.closing || generation !== this.diagnosticGeneration) throw new Error('Managed startup cancelled because the window closed or provider configuration changed.');
        this.diagnostics.set(task.provider, diagnostic);
        const testedVersion = task.provider === 'claude' ? testedClaudeVersion : testedCodexVersion;
        if (diagnostic.status !== 'checked' || diagnostic.version !== testedVersion) throw new Error(`Managed ${task.provider} supports tested CLI ${testedVersion} only. Use the terminal for another version; see provider diagnostics.`);
        task.providerVersion = diagnostic.version;
        await this.managed.start(task, info.executable, message.type === 'followUp' ? message.prompt : task.prompt);
      } catch (error) {
        if (!this.managed.has(task.id)) { task.state = 'error'; task.error = this.describe(error); await this.persist(); }
        throw error;
      } finally { this.diagnosticChecks.delete(controller); this.busy = false; await this.publish(); }
      return;
    }
    if (message.type === 'releaseExternal') {
      if (task.interface !== 'official-extension') return;
      task.interface = 'interactive-cli';
      task.state = 'idle';
      task.error = undefined;
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return;
    }
    if (message.type === 'handoff') {
      if (this.managed.has(task.id)) throw new Error('Stop this managed process before handing off to an official extension.');
      this.busy = true;
      try {
        await handoffTask(task, path.join(this.context.globalStorageUri.fsPath, 'handoffs'), message.provider, this.terminals.has(task.id),
          () => this.persist(), async workspace => { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspace), { forceNewWindow: true }); });
      } finally { this.busy = false; await this.publish(); }
      return;
    }
    if (message.type === 'openWorktree') {
      await this.handle({ type: 'handoff', id: task.id, provider: task.provider });
      return;
    }
    if (message.type === 'openFile') {
      const file = await resolveTaskFile(task.worktree, message.path);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return;
    }
    if (message.type === 'terminal' || message.type === 'launch') {
      assertCliAllowed(task);
      if (this.managed.has(task.id)) throw new Error('Stop the managed process before opening a terminal writer.');
      const existing = this.terminals.get(task.id);
      if (existing) { existing.show(false); return; }
      const max = vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2);
      if (this.terminals.size + this.managed.count >= max) throw new Error(`The ${max}-task concurrency limit is reached. Stop a task writer before launching another.`);
      await this.refreshProviders();
      const provider = this.providers.find(item => item.provider === task.provider);
      if (!provider?.executable) throw new Error(`${task.provider} CLI not found. Install it or set Hydra's ${task.provider} path. Authentication remains with the official CLI.`);
      // Recheck after async probes to prevent simultaneous webview launches exceeding the limit.
      if (this.busy) throw new Error('Another task operation is in progress.');
      assertCliAllowed(task);
      if (this.managed.has(task.id)) throw new Error('Stop the managed process before opening a terminal writer.');
      const duplicate = this.terminals.get(task.id);
      if (duplicate) { duplicate.show(false); return; }
      if (this.terminals.size + this.managed.count >= max) throw new Error('The task concurrency limit is reached.');
      const terminal = vscode.window.createTerminal({ name: `Hydra · ${task.title}`, cwd: task.worktree, ...terminalLaunch(provider.executable), isTransient: true });
      this.terminals.set(task.id, terminal);
      task.interface = 'interactive-cli';
      task.state = 'external';
      task.error = undefined;
      task.updatedAt = new Date().toISOString();
      terminal.show(false);
      await this.persist();
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.integrationAbort?.controller.abort();await this.pendingIntegration?.catch(()=>{});
    await this.pendingCommit?.catch(() => {});
    for (const controller of this.diagnosticChecks) controller.abort();
    await this.managed.shutdown();
    for (const [id, terminal] of this.terminals) {
      terminal.dispose();
      const task = this.getTask(id);
      task.state = 'interrupted';
      task.updatedAt = new Date().toISOString();
    }
    try { if (!this.disabled) await this.store.save(this.tasks); }
    finally { for (const lock of this.locks) await lock.release(); }
  }
  private getIntegration(task:Task,id:string):IntegrationOperation{
    const op=this.integrationOperations.get(task.id);
    if(!op||op.id!==id)throw new Error('Integration operation expired. Select the current candidate.');
    return op;
  }
}
