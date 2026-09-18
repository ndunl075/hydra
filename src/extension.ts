import { TaskScheduler, configureSchedule, pendingSchedule } from './core/scheduler';
import { prepareScheduledTask } from './core/schedulerGit';
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
import { prepareDiscard, confirmDiscard, restoreDiscarded, type DiscardReview } from './core/discard';
import type { IntegrationOperation } from './core/integrationModel';
import { ReviewDocuments } from './extensionReview';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { ProviderAccounts } from './extensionAccounts';
import { ProviderQuota } from './extensionQuota';
import { findProvider, terminalLaunch } from './core/providers';
import { checkProvider } from './core/diagnostics';
import { ManagedSessions } from './core/managedSessions';
import { SessionStore } from './core/sessionStore';
import { buildTaskPrompt, canEditBrief, lockTaskContext, renderTaskHandoff } from './core/taskContext';
import { usageSnapshot } from './core/usage';
import { assessBudgets, BudgetHoldError, checkBudgetLaunch, emptyBudgets, type BudgetSettings } from './core/budgets';
import { BudgetStore } from './core/budgetStore';
import { discoverCodexModels } from './core/codexModels';
import { requireAdvertisedSelection, type ModelCatalog } from './core/modelSelection';
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
  getChildren(): Task[] { return this.tasks().filter(task => task.state !== 'discarded'); }
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
  private readonly budgetStore: BudgetStore;
  private budgets: BudgetSettings = emptyBudgets();
  private pendingBudgetSave?: Promise<void>;
  private readonly storageDirectory: string;
  private snapshotGeneration = 0;
  private pendingNewTask = false;
  private handoff?: Handoff;
  private readonly diagnostics = new Map<Provider, ProviderDiagnostic>();
  private readonly modelCatalogs = new Map<string, ModelCatalog>();
  private readonly diagnosticChecks = new Set<AbortController>();
  private diagnosticGeneration = 0;
  private readonly managed: ManagedSessions;
  private readonly scheduler: TaskScheduler;
  private schedulerReady = false;
  private readonly review: ReviewDocuments;
  private readonly commitReviews = new Map<string, PreparedReview>();
  private readonly discardReviews = new Map<string, DiscardReview>();
  private pendingDiscard?: Promise<void>;
  private pendingCommit?: Promise<ReviewedCommit>;
  private readonly integrations: Integrations;
  private readonly integrationOperations = new Map<string, IntegrationOperation>();
  private pendingIntegration?: Promise<unknown>;
  private integrationAbort?: { taskId: string; operationId?: string; controller: AbortController };
  private readonly settings: AppearanceSettings;
  private readonly settingsImport: SettingsImport;
  private readonly onboarding: Onboarding;
  private readonly accounts: ProviderAccounts;
  private readonly quota: ProviderQuota;
  private fileCache?: { id: string; expires: number; files: Snapshot['files']; error?: string };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsImport = new SettingsImport(context);
    this.accounts = new ProviderAccounts(context, this.settingsImport.available);
    this.quota = new ProviderQuota(context, this.settingsImport.available);
    this.settings = new AppearanceSettings(context.extensionUri, this.settingsImport);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings);
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.store = new LocalStore(this.storageDirectory);
    this.budgetStore = new BudgetStore(this.storageDirectory);
    this.integrations = new Integrations(path.join(this.storageDirectory,'integrations'),op=>{
      this.integrationOperations.set(op.taskId,op);
      if(this.integrationAbort?.taskId===op.taskId)this.integrationAbort.operationId=op.id;
      void this.publish();
    });
    this.review = new ReviewDocuments(context);
    this.scheduler = new TaskScheduler({
      tasks: () => this.tasks,
      capacity: () => Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2))),
      liveCount: () => this.terminals.size + this.managed.count,
      enabled: () => this.schedulerReady && !this.busy && !this.closing && !this.disabled && !this.handoff && vscode.workspace.isTrusted,
      persist: () => this.persist(),
      budget: task => this.checkBudget(task),
      prepare: task => prepareScheduledTask(task, this.tasks, async item => {
        await this.verifyWorktree(item);
        if (this.terminals.has(item.id) || this.managed.has(item.id) || item.state === 'external' || item.state === 'running') throw new Error('Stop the task writer before dependency preparation.');
        const root = await realpath(item.worktree);
        if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && isInside(root, document.uri.fsPath))) throw new Error('Save or revert unsaved task buffers before dependency preparation.');
      }),
      launch: (task, request) => this.handle({ ...request, id: task.id }, true)
    });
    this.managed = new ManagedSessions(new SessionStore(path.join(this.storageDirectory, 'sessions')), () => this.persist(), () => { void this.persist().catch(error => this.report(error)); }, error => this.report(error));
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
    command('hydra.openAccounts', () => this.accounts.show());
    command('hydra.getAccountSetupState', () => this.accounts.snapshot());
    command('hydra.openQuotaStatus', () => this.quota.show());
    command('hydra.getQuotaState', () => this.quota.snapshot());
    command('hydra.refreshQuota', () => this.quota.refresh());
    command('hydra.cancelQuota', () => this.quota.cancel());
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
    command('hydra.configureSchedule', (id: string, dependencies: string[], startFromDependency?: string) => this.handle({ type: 'configureSchedule', id, dependencies, startFromDependency }));
    command('hydra.cancelQueued', (id: string) => this.handle({ type: 'cancelQueued', id }));
    command('hydra.reconcileWriter', (id: string) => this.handle({ type: 'reconcileWriter', id }));
    command('hydra.stopTask', (id: string) => this.handle({ type: 'stop', id }));
    command('hydra.listTasks', () => structuredClone(this.tasks));
    command('hydra.saveBrief', (id: string, brief: unknown) => this.handle({ type: 'saveBrief', id, brief }));
    command('hydra.saveHandoffSummary', (id: string, handoffSummary: unknown) => this.handle({ type: 'saveHandoffSummary', id, handoffSummary }));
    command('hydra.showTaskHandoff', (id: string) => this.handle({ type: 'showTaskHandoff', id }));
    command('hydra.getUsage', () => structuredClone(usageSnapshot(this.tasks, id => this.managed.view(id))));
    command('hydra.getBudgets', () => structuredClone(this.budgetSnapshot()));
    command('hydra.saveBudgets', (id: string, scope: string, budgets: unknown) => this.handle({ type: 'saveBudgets', id, scope, budgets }));
    command('hydra.retryBudgetHold', (id: string) => this.handle({ type: 'retryBudgetHold', id }));
    command('hydra.checkModels', async (id: string) => { await this.handle({ type: 'checkModels', id }); return structuredClone(this.modelCatalogs.get(id)); });
    command('hydra.saveModelSelection', (id: string, selection: unknown) => this.handle({ type: 'saveModelSelection', id, selection }));
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
    command('hydra.prepareDiscard', async (id: string) => { await this.handle({ type: 'prepareDiscard', id }); return structuredClone(this.discardReviews.get(id)); });
    command('hydra.confirmDiscard', (id: string, token: string) => this.handle({ type: 'confirmDiscard', id, token }));
    command('hydra.restoreDiscarded', (id: string) => this.handle({ type: 'restoreDiscarded', id }));
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
        this.diagnosticGeneration++; this.diagnostics.clear(); this.modelCatalogs.clear();
        for (const controller of this.diagnosticChecks) controller.abort();
        void this.refresh().catch(error => this.report(error));
      }
    }));
    try {
      this.tasks = await this.store.load();
      this.budgets = await this.budgetStore.load();
      this.scheduler.reconcile();
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
          if (task.state !== 'discarded') {
            try { await this.verifyWorktree(task); }
            catch (error) { task.state = 'error'; task.error = this.describe(error); }
          }
          if (task.interface === 'managed-cli' || task.sessionId) {
            try { await this.managed.load(task); }
            catch (error) { if (task.state !== 'discarded') task.state = 'error'; task.error = this.describe(error); }
          }
        }
        await this.store.save(this.tasks);
        for(const op of await this.integrations.recover(this.tasks))this.integrationOperations.set(op.taskId,op);
      }
      this.selectedId = this.tasks.find(task => task.state !== 'discarded')?.id;
      this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
    } catch (error) { this.disabled = true; this.report(error); }
    try { await this.refreshProviders(); }
    catch (error) { this.report(error); }
    try {
      this.handoff = parseHandoff(vscode.workspace.getConfiguration('hydra').get('handoff'));
      if (this.handoff) { await this.verifyHandoffWorkspace(); await this.openAgents(); }
    } catch (error) { this.disabled = true; this.report(error); }
    this.schedulerReady = true;
    await this.publish();
    await this.scheduler.drain();
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
  private async refresh(): Promise<void> { this.error = undefined; this.fileCache = undefined; await this.refreshProviders(); await this.publish(); await this.scheduler.drain(); }
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
  private async persist(): Promise<void> {
    // Session completions can save unrelated tasks while discard/restore commits
    // an immutable record. Wait so an older snapshot cannot overwrite that record.
    await this.pendingDiscard?.catch(() => {});
    for (const task of this.tasks) {
      const s = task.schedule;
      if (!s || !['running', 'waiting-for-approval'].includes(s.state)) continue;
      if (this.managed.has(task.id)) s.state = this.managed.view(task.id)?.approvals?.length ? 'waiting-for-approval' : 'running';
      else if (!this.terminals.has(task.id)) {
        s.state = task.state === 'idle' ? 'finished' : task.state === 'error' ? 'blocked' : 'interrupted';
        s.reason = task.error;
        if (s.state === 'finished' || s.state === 'interrupted') s.request = undefined;
      }
    }
    await this.store.save(this.tasks); await this.publish();
    if (this.schedulerReady) queueMicrotask(() => { void this.scheduler.drain().catch(error => this.report(error)); });
  }
  private reviewBlocked(task: Task): boolean { return pendingSchedule(task) || this.busy || this.closing || this.disabled || !vscode.workspace.isTrusted || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external'; }
  private async guardCommitReview(task: Task): Promise<void> {
    if (task.state === 'discarded') throw new Error('Restore this discarded task before review.');
    if (pendingSchedule(task)) throw new Error('Cancel queued work or reconcile the writer before reviewing or integrating this task.');
    if (this.closing || this.disabled || !vscode.workspace.isTrusted || this.handoff || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension') throw new Error('Stop the task writer and acknowledge external handback before preparing a commit review.');
    const root = await realpath(task.worktree);
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const file = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
      if (isInside(root, file) || isInside(root, document.uri.fsPath)) throw new Error('Save or revert unsaved task editor buffers before preparing a commit review.');
    }
  }
  private async guardIntegration(task:Task,paths:string[]):Promise<void>{
    if (pendingSchedule(task)) throw new Error('Cancel queued work or reconcile the writer before integration.');
    await this.guardCommitReview(task);
    for(const directory of paths){
      const root=await realpath(directory);
      for(const document of vscode.workspace.textDocuments){
        if(!document.isDirty||document.uri.scheme!=='file')continue;
        const file=await realpath(document.uri.fsPath).catch(()=>document.uri.fsPath);
        if(isInside(root,file)||isInside(root,document.uri.fsPath))throw new Error('Save or revert unsaved task, target, and candidate editor buffers before integration.');
      }
    }
    if(pendingSchedule(task)||this.closing||this.disabled||!vscode.workspace.isTrusted)throw new Error('Integration cancelled because the workspace closed or lost trust.');
  }
  private async guardDiscard(task: Task, restoring = false): Promise<void> {
    if (this.closing || this.disabled || this.handoff || !vscode.workspace.isTrusted || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension' || pendingSchedule(task) || task.schedule?.request) throw new Error('Stop task writers, cancel queued work, and reconcile uncertain ownership before discard or restore.');
    if (!restoring && task.state === 'discarded') throw new Error('This task is already discarded.');
    if (this.integrationAbort?.taskId === task.id) throw new Error('Finish or cancel integration before discard.');
    if (this.tasks.some(item => item.schedule?.state === 'starting' && item.schedule.dependencies.includes(task.id))) throw new Error('A dependent task is starting. Wait for startup before discard.');
    await this.verifyWorktree(task);
    const root = await realpath(task.worktree);
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const file = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
      if (isInside(root, file) || isInside(root, document.uri.fsPath)) throw new Error('Save or revert unsaved task editor buffers before discard or restore.');
    }
    if (this.closing || this.disabled || !vscode.workspace.isTrusted) throw new Error('Workspace closed or lost trust. Task preserved.');
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
    if (task && task.state !== 'discarded' && vscode.workspace.isTrusted) {
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
      discardReview: task ? this.discardReviews.get(task.id) : undefined,
      usage: usageSnapshot(this.tasks, id => this.managed.view(id)),
      budgets: this.budgetSnapshot(),
      modelCatalogs: Object.fromEntries(this.modelCatalogs),
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
  private budgetSnapshot(): NonNullable<Snapshot['budgets']> {
    const usage = usageSnapshot(this.tasks, id => this.managed.view(id));
    return { settings: this.budgets, observations: Object.fromEntries(this.tasks.map(task => [task.id, assessBudgets(task, this.budgets, usage)])) };
  }
  private checkBudget(task: Task, markHold = false): string[] {
    try {
      return checkBudgetLaunch(task.provider, assessBudgets(task, this.budgets, usageSnapshot(this.tasks, id => this.managed.view(id))));
    } catch (error) {
      if (markHold && error instanceof BudgetHoldError && task.schedule?.request && !task.schedule.uncertain) {
        task.schedule.state = 'blocked'; task.schedule.budgetHold = true; task.schedule.reason = error.message;
      }
      throw error;
    }
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
  private async handle(value: unknown, scheduledLaunch = false): Promise<void> {
    const message = parseMessage(value);
    const expectedSchedule = scheduledLaunch && 'id' in message ? this.getTask(message.id).schedule : undefined;
    const assertLaunchCurrent = () => { if (scheduledLaunch && (!expectedSchedule || !('id' in message) || this.getTask(message.id).schedule !== expectedSchedule || expectedSchedule.state !== 'starting' || !expectedSchedule.request)) throw new Error('Queued launch cancelled before provider start.'); };
    if (message.type === 'ready') { await this.publish(); if (this.pendingNewTask) { this.pendingNewTask = false; await this.panel?.webview.postMessage({ type: 'newTask' }); } return; }
    if (message.type === 'openQuota') { this.quota.show(); return; }
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'settings') { this.settings.show(); return; }
    if (message.type === 'refresh') { this.error = undefined; await this.refresh(); return; }
    if (message.type === 'draft') { this.draft = { title: message.title, prompt: message.prompt, provider: message.provider, brief: message.brief }; return; }
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
    if (this.handoff && ['create', 'handoff', 'launch', 'terminal', 'openWorktree', 'startManaged', 'followUp', 'prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'saveBudgets', 'retryBudgetHold'].includes(message.type)) throw new Error('This window is an official-extension handoff. Manage task writers from the original Hydra window.');
    if (this.busy && ['create', 'handoff', 'releaseExternal', 'prepareCommitReview', 'commitReviewed', 'prepareIntegration', 'promoteIntegration', 'reviewIntegrationResolution', 'acceptIntegrationResolution', 'prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'launch', 'terminal', 'startManaged', 'followUp', 'configureSchedule', 'saveBrief', 'saveHandoffSummary', 'saveModelSelection', 'saveBudgets', 'retryBudgetHold'].includes(message.type)) throw new Error('Another task operation is in progress.');
    if (message.type === 'create') {
      if (this.busy) throw new Error('Another task operation is in progress.');
      if (!this.repositories.includes(message.repository)) throw new Error('Choose an open workspace repository.');
      this.busy = true;
      await this.publish();
      try {
        const id = randomBytes(6).toString('hex');
        const worktree = await createWorktree(message.repository, message.title, id, vscode.workspace.getConfiguration('hydra').get<string>('worktreeRoot'), message.startingCommit);
        const now = new Date().toISOString();
        this.tasks.push({ id, title: message.title.trim(), prompt: message.brief ? buildTaskPrompt(message.brief) : message.prompt.trim(), brief: message.brief, provider: message.provider,
          repository: message.repository, ...worktree, interface: 'interactive-cli', state: 'idle', createdAt: now, updatedAt: now });
        this.selectedId = id;
        this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
        await this.persist();
        await this.panel?.webview.postMessage({ type: 'taskCreated' });
      } finally { this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
      return;
    }
    if (!('id' in message)) throw new Error('Expected a task command.');
    const task = this.getTask(message.id);
    if (task.state === 'discarded' && !['select', 'copyDiscardLocation', 'restoreDiscarded', 'showSessionDiagnostics'].includes(message.type)) throw new Error('Restore this discarded task before continuing work.');
    if (message.type === 'saveBudgets') {
      this.busy = true;
      const candidate = structuredClone(this.budgets);
      const records = message.scope === 'task' ? candidate.tasks : candidate.projects;
      const key = message.scope === 'task' ? task.id : task.repository;
      if (message.budgets.length) records[key] = message.budgets; else delete records[key];
      this.pendingBudgetSave = this.budgetStore.save(candidate);
      try { await this.pendingBudgetSave; this.budgets = candidate; }
      finally { this.pendingBudgetSave = undefined; this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
      return;
    }
    if (message.type === 'retryBudgetHold') {
      if (this.managed.has(task.id) || this.terminals.has(task.id)) throw new Error('Stop this writer before retrying held work.');
      await this.scheduler.retryBudgetHold(task); return;
    }
    if (message.type === 'copyDiscardLocation') {
      if (task.state !== 'discarded') throw new Error('This task has not been discarded.');
      await vscode.env.clipboard.writeText(task.worktree); return;
    }
    if (message.type === 'prepareDiscard' || message.type === 'confirmDiscard' || message.type === 'restoreDiscarded') {
      this.busy = true; await this.publish();
      try {
        const guard = () => this.guardDiscard(task, message.type === 'restoreDiscarded');
        if (message.type === 'prepareDiscard') {
          this.discardReviews.set(task.id, await prepareDiscard(task, this.tasks, guard)); return;
        }
        if (message.type === 'restoreDiscarded') {
          this.pendingDiscard = restoreDiscarded(task, this.tasks, guard, records => this.store.save(records));
          await this.pendingDiscard;
        } else if (message.type === 'confirmDiscard') {
          const review = this.discardReviews.get(task.id);
          if (!review || review.token !== message.token) throw new Error('Discard review expired. Prepare a fresh review.');
          this.discardReviews.delete(task.id);
          await guard();
          const answer = await vscode.window.showWarningMessage(`Discard “${task.title}”?`, { modal: true, detail: `${review.unmergedCommits.length} unmerged commits and ${review.changes.length} saved changed files.\nBranch: ${task.branch}\nCheckout: ${task.worktree}\n\nThe task leaves active work. Its complete checkout, ignored files, branch and diagnostics stay in place for recovery. Restore it from Discarded to work again. No provider request is sent.` }, 'Discard task');
          if (answer !== 'Discard task') return;
          this.pendingDiscard = confirmDiscard(task, this.tasks, review, guard, records => this.store.save(records));
          await this.pendingDiscard;
        }
        this.commitReviews.delete(task.id); this.discardReviews.delete(task.id); this.fileCache = undefined;
        if (task.state === 'discarded') this.selectedId = this.tasks.find(item => item.state !== 'discarded')?.id;
      } finally { this.pendingDiscard = undefined; this.busy = false; await this.publish(); if (!this.closing) await this.scheduler.drain(); }
      return;
    }
    if (task.modelSelection && ['launch', 'terminal', 'handoff', 'openWorktree'].includes(message.type)) throw new Error('This task has an explicit managed Codex model selection. Start it with Run managed task; terminal and official-extension settings cannot be verified by Hydra. Clear the selection before its first launch to use those interfaces.');
    if (message.type === 'saveModelSelection') {
      if (this.busy || !canEditBrief(task, this.managed.view(task.id))) throw new Error('Model settings are locked after launch. Create a new task to use another selection.');
      if (task.provider !== 'codex') throw new Error('Verified model and effort controls are currently available only for managed Codex. Claude can silently cap effort in structured output; use its official client.');
      if (message.selection) {
        const catalog = this.modelCatalogs.get(task.id);
        if (catalog?.status !== 'ready') throw new Error('Load available Codex models before saving a selection.');
        requireAdvertisedSelection(catalog.models, message.selection);
      }
      task.modelSelection = message.selection || undefined; task.updatedAt = new Date().toISOString();
      await this.persist(); await this.publish(); return;
    }
    if (message.type === 'checkModels') {
      if (task.provider !== 'codex') throw new Error('Verified model discovery is available only for Codex.');
      if (this.busy || this.modelCatalogs.get(task.id)?.status === 'checking') throw new Error('Another task or model check is in progress.');
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.modelCatalogs.set(task.id, { status: 'checking', models: [], checkedAt: new Date().toISOString() });
      await this.publish();
      try {
        await this.verifyWorktree(task);
        const info = await findProvider('codex', vscode.workspace.getConfiguration('hydra').get<string>('codexPath'));
        const diagnostic = await checkProvider(info, task.worktree, controller.signal);
        if (!info.executable || diagnostic.status !== 'checked' || diagnostic.version !== testedCodexVersion) throw new Error('Model discovery requires the configured official Codex 0.154.0 executable.');
        const models = await discoverCodexModels(info.executable, task.worktree, controller.signal);
        if (generation === this.diagnosticGeneration && !this.closing) this.modelCatalogs.set(task.id, { status: 'ready', models, checkedAt: new Date().toISOString() });
      } catch (error) {
        if (generation === this.diagnosticGeneration && !this.closing) this.modelCatalogs.set(task.id, { status: 'error', models: [], checkedAt: new Date().toISOString(), error: this.describe(error) });
      } finally { this.diagnosticChecks.delete(controller); await this.publish(); }
      return;
    }
    if (message.type === 'saveBrief' || message.type === 'saveHandoffSummary' || message.type === 'showTaskHandoff') {
      if (this.busy) throw new Error('Another task operation is in progress.');
      if (message.type === 'saveBrief') {
        if (!canEditBrief(task, this.managed.view(task.id))) throw new Error('The initial task brief is locked after launch. Send changes as an explicit follow-up.');
        task.brief = message.brief; task.prompt = buildTaskPrompt(message.brief);
      } else if (message.type === 'saveHandoffSummary') {
        task.handoffSummary = message.handoffSummary;
      } else {
        const content = renderTaskHandoff(task, this.managed.store.historyPath(task.id), (this.managed.view(task.id)?.turns || []).map(turn => ({ id: turn.id, status: turn.status, evidencePath: this.managed.store.rawPath(task.id, turn.id) })));
        const handoffPath = path.join(path.dirname(this.managed.store.historyPath(task.id)), 'handoff.md');
        const expectedPath = await realpath(handoffPath).catch(() => handoffPath);
        for (const document of vscode.workspace.textDocuments) {
          if (!document.isDirty || document.uri.scheme !== 'file') continue;
          const actualPath = await realpath(document.uri.fsPath).catch(() => document.uri.fsPath);
          if (path.relative(expectedPath, actualPath) === '') throw new Error('Save or revert unsaved generated handoff notes before regenerating this file.');
        }
        const filename = await this.managed.store.saveHandoff(task.id, content);
        await vscode.window.showTextDocument(vscode.Uri.file(filename), { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
      task.updatedAt = new Date().toISOString();
      await this.persist(); await this.publish(); return;
    }
    if (message.type === 'select') { this.selectedId = task.id; await this.publish(); return; }
    if (message.type === 'copyPrompt') { await vscode.env.clipboard.writeText(task.prompt); void vscode.window.showInformationMessage('Task prompt copied. Paste it into the provider terminal when ready.'); return; }
    if (!scheduledLaunch && ['configureSchedule', 'handoff', 'openWorktree', 'prepareCommitReview', 'commitReviewed', 'releaseExternal', 'prepareIntegration', 'promoteIntegration', 'reviewIntegrationResolution', 'acceptIntegrationResolution'].includes(message.type) && this.tasks.some(item => item.schedule?.state === 'starting' && (item.id === task.id || item.schedule.dependencies.includes(task.id)))) throw new Error('A queued launch is preparing this task or its dependency receipt. Wait for startup to finish.');
    if (message.type === 'configureSchedule') {
      if (this.busy || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'external' || task.state === 'running') throw new Error('Stop this writer before editing dependencies.');
      configureSchedule(task, this.tasks, message.dependencies, message.startFromDependency);
      await this.persist(); return;
    }
    if (message.type === 'cancelQueued') { if (this.managed.has(task.id) || this.terminals.has(task.id)) throw new Error('Stop the owned writer first.'); await this.scheduler.cancel(task); return; }
    if (message.type === 'reconcileWriter') {
      if (this.terminals.has(task.id) || this.managed.has(task.id)) throw new Error('Stop the owned writer first.');
      const answer = await vscode.window.showWarningMessage('Confirm you have stopped any surviving provider process for this task. Hydra cannot prove writer absence after a restart.', { modal: true }, 'Writer stopped');
      if (answer === 'Writer stopped') await this.scheduler.reconcileStopped(task);
      return;
    }
    if (!scheduledLaunch && ['launch', 'terminal', 'startManaged', 'followUp'].includes(message.type)) {
      if (this.integrationAbort?.taskId === task.id) throw new Error('Finish or cancel this task integration before queueing another writer.');
      if ((message.type === 'launch' || message.type === 'terminal') && this.terminals.has(task.id)) { this.terminals.get(task.id)!.show(false); return; }
      assertCliAllowed(task);
      if (this.managed.has(task.id)) throw new Error('Stop the managed process before queueing another launch.');
      if (this.terminals.has(task.id) || task.state === 'external' || task.state === 'running') throw new Error('Stop this task writer before queueing another launch.');
      if (message.type === 'startManaged' && task.sessionId) throw new Error('Send a follow-up to resume this session.');
      if (message.type === 'followUp' && !task.sessionId) throw new Error('Start the task before sending a follow-up.');
      await lockTaskContext(task, () => this.persist());
      await this.scheduler.enqueue(task, message.type === 'followUp' ? { type: 'followUp', prompt: message.prompt } : { type: message.type as 'launch' | 'terminal' | 'startManaged' });
      return;
    }
    if (['handoff', 'openWorktree'].includes(message.type) && this.managed.has(task.id)) throw new Error('Stop the managed process before handing off.');
    if (!scheduledLaunch && pendingSchedule(task) && ['handoff', 'openWorktree', 'prepareCommitReview', 'commitReviewed', 'prepareIntegration', 'promoteIntegration', 'reviewIntegrationResolution', 'acceptIntegrationResolution'].includes(message.type)) throw new Error('Cancel queued work or reconcile the writer before this action.');
    if (message.type === 'stop') {
      // Process handles become available before startup's final metadata save completes.
      // Stop an owned writer even while its scheduling record still says starting.
      if (this.managed.has(task.id)) { await this.managed.stop(task.id); return; }
      const terminal = this.terminals.get(task.id);
      if (terminal) { terminal.dispose(); return; }
      if (task.schedule?.state === 'starting') { await this.scheduler.cancel(task); return; }
      if (task.schedule && ['queued', 'blocked'].includes(task.schedule.state)) { await this.scheduler.cancel(task); return; }
      if (this.busy && task.state === 'running') throw new Error('This process is still being prepared. Stop it once startup finishes.');
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
      try{await this.pendingIntegration;}finally{this.pendingIntegration=undefined;this.integrationAbort=undefined;this.busy=false;this.fileCache=undefined;await this.publish();if(this.schedulerReady)void this.scheduler.drain().catch(error=>this.report(error));}
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
          task.state = 'idle'; task.error = undefined;
          if (task.schedule && !task.schedule.uncertain) { task.schedule.state = 'finished'; task.schedule.request = undefined; task.schedule.reason = undefined; }
          task.updatedAt = new Date().toISOString();
          await this.persist();
        }
      } finally { this.pendingCommit = undefined; this.fileCache = undefined; this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
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
    if (['startManaged', 'followUp', 'launch', 'terminal', 'handoff'].includes(message.type)) {
      this.commitReviews.delete(task.id);
      // Persist before any writer can start; failures remain locked for an inspectable history.
      if (!task.contextLockedAt) await lockTaskContext(task, () => this.persist());
    }
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
        assertLaunchCurrent();
        this.checkBudget(task, true);
        task.providerVersion = diagnostic.version;
        await this.managed.start(task, info.executable, message.type === 'followUp' ? message.prompt : task.prompt, () => { this.checkBudget(task, true); });
      } catch (error) {
        if (!this.managed.has(task.id)) { task.state = expectedSchedule?.state === 'cancelled' ? 'interrupted' : 'error'; task.error = expectedSchedule?.state === 'cancelled' ? undefined : this.describe(error); await this.persist(); }
        throw error;
      } finally { this.diagnosticChecks.delete(controller); this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
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
      } finally { this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
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
      assertLaunchCurrent();
      this.checkBudget(task, true);
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
    await this.accounts.shutdown();
    await this.quota.shutdown();
    this.integrationAbort?.controller.abort();await this.pendingIntegration?.catch(()=>{});
    await this.pendingCommit?.catch(() => {});
    await this.pendingDiscard?.catch(() => {});
    await this.pendingBudgetSave?.catch(() => {});
    for (const controller of this.diagnosticChecks) controller.abort();
    await this.managed.shutdown();
    this.scheduler.reconcile();
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
