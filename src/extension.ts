import { ProfileCapacity } from './core/profileCapacity';
import { TaskResources } from './core/resources';
import { TaskScheduler, configureSchedule, pendingSchedule } from './core/scheduler';
import { prepareScheduledTask } from './core/schedulerGit';
import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
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
import { executableFingerprint, findProvider, terminalLaunch } from './core/providers';
import { JobStore } from './core/jobs';
import { HelperEndpoint } from './core/helperEndpoint';
import { HelperService } from './core/helperService';
import { removeWindowRecord, writeWindowRecord } from './core/helperDiscovery';
import { startHelperRun } from './core/helperRunner';
import { createLeadVerifier } from './core/leadVerification';
import { claudeMemStatus, setupClaudeMem } from './core/claudeMem';
import { downloadOpenVsx } from './core/openVsx';
import { selfCheckCli } from './core/cliSelfCheck';
import { claudeStatus, codexStatus, connectClaude, connectCodex, disconnectClaude, disconnectCodex, helperWrittenEntries, providerPaths, type ConnectableProvider, type HelperServerSpec, type WrittenEntries } from './core/helperRegistration';
import type { ProviderConnectionView } from './helperConnectionsView';
import { addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, maskSecret, removeMcpServer, testMcpServer, validateServerSpec, type McpAgent } from './core/mcpServers';
import { checkProvider } from './core/diagnostics';
import { settingsRequiringRefresh } from './core/settingsRefresh';
import { ManagedSessions } from './core/managedSessions';
import { SessionStore } from './core/sessionStore';
import { ConversationDrafts } from './core/conversationDrafts';
import { buildTaskPrompt, canEditBrief, lockTaskContext, renderTaskHandoff } from './core/taskContext';
import { usageSnapshot } from './core/usage';
import { projectSelectedTaskSetupPreview } from './core/setupPreviewProjection';
import { assessBudgets, BudgetHoldError, checkBudgetLaunch, emptyBudgets, type BudgetSettings } from './core/budgets';
import { BudgetStore } from './core/budgetStore';
import { discoverCodexModels } from './core/codexModels';
import { discoverClaudeModels } from './core/claudeModels';
import { requireClaudeSelection } from './core/claudeControls';
import { requireAdvertisedSelection, type ModelCatalog } from './core/modelSelection';
import { supportedCliDescription, supportedCliVersion } from './core/cliVersions';
import type { Provider, ProviderDiagnostic, PreparedReview, ReviewedCommit } from './core/model';
import { assertCliAllowed, handoffTask, parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { registerChatLocationController, setChatLocation } from './chatLocationController';
import { parseMessage, type Task, type Snapshot, type ProviderInfo, type Draft, type Handoff, type HandoffTask } from './core/model';

let manager: Manager | undefined;
/** Every contributed Hydra setting except the preference-only ones (see settingsRefresh). */
function otherHydraSettings(context: vscode.ExtensionContext): string[] {
  return settingsRequiringRefresh([context.extension.packageJSON?.contributes?.configuration].flat().flatMap((section: { properties?: Record<string, unknown> } | undefined) => Object.keys(section?.properties || {})));
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerChatLocationController(context);
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
  private conversation?: vscode.WebviewView;
  private readonly conversationDrafts = new ConversationDrafts();
  private selectedId?: string;
  private mode: 'editor' | 'agents' = 'editor';
  private busy = false;
  private error?: string;
  private disabled = false;
  private closing = false;
  private draft?: Draft;
  private terminals = new Map<string, vscode.Terminal>();
  private readonly tree = new TaskTree(() => this.tasks);
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('Hydra');
  /** When each task's current send was received, for launch step timing in the Hydra log. */
  private readonly sendStarted = new Map<string, number>();
  private mark(taskId: string, step: string): void {
    const start = this.sendStarted.get(taskId);
    if (start !== undefined) this.output.appendLine(`[timing] ${taskId} +${Date.now() - start}ms ${step}`);
  }
  private readonly locks: OwnershipLock[] = [];
  private readonly store: LocalStore;
  private readonly budgetStore: BudgetStore;
  private budgets: BudgetSettings = emptyBudgets();
  private pendingBudgetSave?: Promise<void>;
  private readonly storageDirectory: string;
  /** Hydra helpers for this window (docs/Official_Extensions_Plan.md): job store, local endpoint, service, discovery record. */
  private helpers?: { store: JobStore; endpoint: HelperEndpoint; service: HelperService; record: string };
  private snapshotGeneration = 0;
  private pendingNewTask = false;
  private handoff?: Handoff;
  private readonly diagnostics = new Map<Provider, ProviderDiagnostic>();
  /** The last passing launch probe per provider, valid only for the identical binary. */
  private readonly launchProbes = new Map<Provider, { fingerprint: string; diagnostic: ProviderDiagnostic }>();
  private readonly modelCatalogs = new Map<string, ModelCatalog>();
  private readonly draftModelCatalogs = new Map<Provider, ModelCatalog>();
  private readonly diagnosticChecks = new Set<AbortController>();
  private diagnosticGeneration = 0;
  private readonly managed: ManagedSessions;
  private readonly resources: TaskResources;
  private readonly capacity: ProfileCapacity;
  private readonly capacityStarting = new Set<string>();
  private pendingResource?: { id: string; controller: AbortController; done: Promise<void> };
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
  private approvalPauseReplay: Promise<void> = Promise.resolve();
  private fileCache?: { id: string; expires: number; files: Snapshot['files']; error?: string };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsImport = new SettingsImport(context);
    this.accounts = new ProviderAccounts(context, this.settingsImport.available);
    this.quota = new ProviderQuota(context, this.settingsImport.available);
    this.settings = new AppearanceSettings(context, this.settingsImport);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings);
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.capacity = new ProfileCapacity(path.join(context.globalStorageUri.fsPath, 'capacity-reservations'), key, () => { void this.publish(); if (this.schedulerReady && !this.closing) void this.scheduler.drain().catch(error => this.report(error)); });
    this.resources = new TaskResources(path.join(this.storageDirectory, 'resources'), path.join(context.globalStorageUri.fsPath, 'resource-reservations'), key, () => { void this.publish(); if (this.schedulerReady && !this.closing) void this.scheduler.drain().catch(error => this.report(error)); }, error => this.report(error));
    this.store = new LocalStore(this.storageDirectory);
    this.budgetStore = new BudgetStore(this.storageDirectory);
    this.integrations = new Integrations(path.join(this.storageDirectory,'integrations'),op=>{
      this.integrationOperations.set(op.taskId,op);
      if(this.integrationAbort?.taskId===op.taskId)this.integrationAbort.operationId=op.id;
      void this.publish();
    }, () => this.tasks);
    this.review = new ReviewDocuments(context);
    this.scheduler = new TaskScheduler({
      tasks: () => this.tasks,
      capacity: () => Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2))),
      liveCount: () => this.terminals.size + this.managed.count + this.resources.count,
      enabled: () => this.schedulerReady && !this.busy && !this.closing && !this.disabled && !this.handoff && vscode.workspace.isTrusted,
      persist: () => this.persist(),
      budget: task => this.checkBudget(task),
      reserve: async (task, request) => {
        this.capacityStarting.add(task.id);
        return this.capacity.tryAcquire(task.id, request.type === 'launch' || request.type === 'terminal' ? 'terminal' : 'managed', this.profileLimit());
      },
      release: async task => { this.capacityStarting.delete(task.id); await this.settleCapacity(); },
      prepare: task => prepareScheduledTask(task, this.tasks, async item => {
        await this.verifyWorktree(item);
        if (this.terminals.has(item.id) || this.managed.has(item.id) || this.resources.has(item.id) || item.state === 'external' || item.state === 'running') throw new Error('Stop the task writer before dependency preparation.');
        const root = await realpath(item.worktree);
        if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && isInside(root, document.uri.fsPath))) throw new Error('Save or revert unsaved task buffers before dependency preparation.');
      }),
      launch: (task, request) => this.handle({ ...request, id: task.id }, true)
    });
    this.managed = new ManagedSessions(new SessionStore(path.join(this.storageDirectory, 'sessions')), () => this.persist(), () => { void this.persist().catch(error => this.report(error)); }, error => this.report(error), {});
  }
  async initialize(): Promise<void> {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, (...args) =>
      Promise.resolve().then(() => callback(...args)).catch(error => { this.report(error); throw error; })));
    command('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    command('hydra.openAgents', () => this.openAgents());
    command('hydra.openConversation', async () => { await this.openEditor(); await vscode.commands.executeCommand('hydra.conversation.focus'); });
    command('hydra.getConversationState', () => ({ mode: this.mode, selectedId: this.selectedId, draft: this.selectedId ? this.conversationDrafts.get(this.selectedId) : undefined }));
    command('hydra.saveConversationDraft', (id: string, prompt: string, version: string) => this.handle({ type: 'conversationDraft', id, prompt, version }));
    command('hydra.newTask', async () => { this.pendingNewTask = !this.panel; await this.openAgents(); await this.panel?.webview.postMessage({ type: 'newTask' }); });
    command('hydra.openTask', async (id: string) => { this.getTask(id); this.selectedId = id; await this.openAgents(); });
    command('hydra.refresh', () => this.refresh());
    command('hydra.openSettings', (pageId?: string) => this.settings.show(pageId));
    command('hydra.setChatLocation', (mode?: 'docked' | 'tabs') => setChatLocation(mode));
    command('hydra.openAccounts', (provider?: 'claude' | 'codex', autoLogin?: boolean) => this.accounts.show(provider, autoLogin));
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
    command('hydra.getCapacity', () => structuredClone(this.capacity.view(this.profileLimit())));
    command('hydra.stopAllHelpers', async () => {
      const stopped = await this.helpers?.service.stopAll() ?? 0;
      void vscode.window.showInformationMessage(stopped ? `Stopped ${stopped} Hydra head${stopped === 1 ? '' : 's'}.` : 'No Hydra heads are running.');
      return stopped;
    });
    command('hydra.listHelpers', () => structuredClone(this.helpers?.service.list() ?? []));
    command('hydra.helperConnections', () => this.helperConnections());
    command('hydra.connectHelpers', async (provider: ConnectableProvider) => ({ warning: await this.connectHelpers(provider), connections: await this.helperConnections() }));
    command('hydra.disconnectHelpers', async (provider: ConnectableProvider) => { await this.disconnectHelpers(provider); return this.helperConnections(); });
    command('hydra.installProviderExtension', async (provider: ConnectableProvider) => { await this.installProviderExtension(provider); return this.helperConnections(); });
    command('hydra.repairClaudeMem', () => this.repairClaudeMem());
    command('hydra.helperWrittenEntries', () => this.helperWrittenEntries());
    // MCP servers (Settings plan, Phase 4). Lists come back with secrets masked; changes return the fresh list.
    const mcp = async () => defaultMcpContext(await this.claudeForRegistration());
    command('hydra.mcpServers.list', async () => listMcpServers(await mcp()));
    command('hydra.mcpServers.add', async (name: unknown, spec: unknown, agents: unknown) => { const context = await mcp(); await addMcpServer(context, name, spec, agents); return listMcpServers(context); });
    command('hydra.mcpServers.remove', async (name: unknown, agent: unknown) => { const context = await mcp(); await removeMcpServer(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.enable', async (name: unknown, agent: unknown) => { const context = await mcp(); await enableMcpServerFor(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.test', async (target: unknown, agent?: McpAgent) => testMcpServer(typeof target === 'string' ? await configuredSpec(await mcp(), target, agent) : validateServerSpec(target)));
    command('hydra.reconcileCapacity', (id: string) => this.handle({ type: 'reconcileCapacity', id }));
    command('hydra.reconcileWriter', (id: string) => this.handle({ type: 'reconcileWriter', id }));
    command('hydra.stopTask', (id: string) => this.handle({ type: 'stop', id }));
    command('hydra.listTasks', () => structuredClone(this.tasks));
    command('hydra.saveBrief', (id: string, brief: unknown) => this.handle({ type: 'saveBrief', id, brief }));
    command('hydra.saveHandoffSummary', (id: string, handoffSummary: unknown) => this.handle({ type: 'saveHandoffSummary', id, handoffSummary }));
    command('hydra.showTaskHandoff', (id: string) => this.handle({ type: 'showTaskHandoff', id }));
    command('hydra.getUsage', () => structuredClone(usageSnapshot(this.tasks, id => this.managed.view(id))));
    command('hydra.getResources', () => this.resources.snapshot());
    command('hydra.saveResources', (id: string, config: unknown) => this.handle({ type: 'saveResources', id, config }));
    for (const type of ['runSetup', 'stopSetup', 'reconcileSetup', 'releaseResources', 'reacquireResources', 'showSetupLog']) command(`hydra.${type}`, (id: string) => this.handle({ type, id }));
    command('hydra.getBudgets', () => structuredClone(this.budgetSnapshot()));
    command('hydra.saveBudgets', (id: string, scope: string, budgets: unknown) => this.handle({ type: 'saveBudgets', id, scope, budgets }));
    command('hydra.retryBudgetHold', (id: string) => this.handle({ type: 'retryBudgetHold', id }));
    command('hydra.checkModels', async (id: string) => { await this.handle({ type: 'checkModels', id }); return structuredClone(this.modelCatalogs.get(id)); });
    command('hydra.saveModelSelection', (id: string, selection: unknown) => this.handle({ type: 'saveModelSelection', id, selection }));
    command('hydra.savePermissionMode', (id: string, permissionMode: unknown) => this.handle({ type: 'savePermissionMode', id, permissionMode }));
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
    command('hydra.followUp', (id: string, prompt: string, draftVersion?: string) => this.handle({ type: 'followUp', id, prompt, draftVersion }));
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
    this.context.subscriptions.push(vscode.window.registerWebviewViewProvider('hydra.conversation', {
      resolveWebviewView: view => {
        this.conversation = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
        view.webview.html = this.html(view.webview, 'editor');
        this.connectWebview(view.webview);
        view.onDidDispose(() => { if (this.conversation === view) this.conversation = undefined; }, undefined, this.context.subscriptions);
        view.onDidChangeVisibility(() => { if (view.visible) void this.publish(); }, undefined, this.context.subscriptions);
      }
    }));
    await vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
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
      if (!event.affectsConfiguration('hydra')) return;
      // Delegation preferences are read fresh wherever they are used and touch no
      // provider, model catalog or repository state. Treating them like a provider
      // path change cleared both model catalogs, aborted provider checks and ran a
      // full refresh on every Solo/Auto flip, so they only republish. Any other
      // Hydra setting, including ones added later, still takes the full path.
      if (!otherHydraSettings(this.context).some(key => event.affectsConfiguration(key))) { void this.publish().catch(error => this.report(error)); return; }
      this.diagnosticGeneration++; this.diagnostics.clear(); this.modelCatalogs.clear(); this.draftModelCatalogs.clear();
      for (const controller of this.diagnosticChecks) controller.abort();
      void this.refresh().catch(error => this.report(error));
    }));
    try {
      this.tasks = await this.store.load();
      this.budgets = await this.budgetStore.load();
      await this.resources.load();
      this.scheduler.reconcile();
      await this.refreshRepositories();
      if (vscode.workspace.isTrusted) {
        // Lock each canonical repository, so different workspace configurations cannot own the same repo.
        for (const repository of [...new Set([...this.repositories, ...this.tasks.map(task => task.repository)])].sort()) {
          const lock = new OwnershipLock();
          await lock.acquire(path.join(this.context.globalStorageUri.fsPath, 'ownership'), repository);
          this.locks.push(lock);
        }
        await this.capacity.refresh();
        this.capacity.startWatching(error => { this.output.appendLine(this.describe(error)); void this.publish(); });
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
    await this.startHelpers().catch(error => { this.output.appendLine(`[heads] not started: ${this.describe(error)}`); });
    await this.publish();
    await this.scheduler.drain();
  }
  /** How a CLI starts Hydra's stdio bridge: this editor's executable as Node, running dist/hydra-mcp.cjs. */
  helperBridge(): { command: string; args: string[]; env: Record<string, string> } {
    return { command: process.execPath, args: [path.join(this.context.extensionPath, 'dist', 'hydra-mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: path.join(this.context.globalStorageUri.fsPath, 'helpers') } };
  }
  private async helperExecutable(provider: Provider): Promise<string> {
    const info = await findProvider(provider, vscode.workspace.getConfiguration('hydra').get<string>(`${provider}Path`));
    if (!info.executable) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI not found. Install it or set Hydra's ${provider} path.`);
    const check = await selfCheckCli(provider, info.executable);
    if (!check.ok) throw new Error(check.error);
    return info.executable;
  }
  /** Helpers need a trusted Git folder. The first repository in the window is the lead's folder. */
  private async startHelpers(): Promise<void> {
    if (this.disabled || this.handoff || !vscode.workspace.isTrusted || this.helpers) return;
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    let leadFolder: string | undefined;
    for (const folder of folders) { try { leadFolder = await repositoryRoot(folder); break; } catch { /* not a Git folder */ } }
    if (!leadFolder) return;
    const directory = path.join(this.storageDirectory, 'helpers');
    const store = new JobStore(directory);
    await store.load();
    const leadKey = path.basename(this.storageDirectory);
    let service: HelperService | undefined;
    const verifyLead = createLeadVerifier(() => ({
      // This window's extension host and its main process start the official
      // extensions' CLIs and Hydra's terminals; helpers are refused by process.
      allowedAncestors: new Set([process.pid, process.ppid]),
      deniedAncestors: service?.helperProcessIds() ?? new Set<number>(),
    }));
    const endpoint = new HelperEndpoint(async (caller, tool, args, signal) => {
      if (!service) throw new Error('Hydra heads are still starting.');
      // Every action is logged, whoever calls it (plan, Phase 3 security note).
      this.output.appendLine(`[heads] ${caller.role}${caller.jobId ? ` ${caller.jobId}` : ''}: ${tool}`);
      return service.handle(caller, tool, args, signal);
    }, { leadKey, verifyLead: async socket => {
      const verdict = await verifyLead(socket);
      this.output.appendLine(`[heads] lead connection ${verdict.ok ? 'accepted' : `refused: ${verdict.reason}`}`);
      return verdict;
    } });
    const port = await endpoint.start();
    service = new HelperService({
      store, endpoint, leadFolder, leadKey,
      worktreeRoot: () => vscode.workspace.getConfiguration('hydra').get<string>('worktreeRoot') || undefined,
      startRun: startHelperRun, executable: provider => this.helperExecutable(provider),
      bridge: this.helperBridge(), logDirectory: path.join(directory, 'logs'),
      maxConcurrent: () => Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentHelpers', 3))),
      onChange: () => this.publishSoon(), log: line => this.output.appendLine(line),
    });
    await service.recover();
    const record = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port, pid: process.pid, folders });
    this.helpers = { store, endpoint, service, record };
    this.output.appendLine(`[heads] ready for ${leadFolder}`);
    void this.refreshHelperConnections();
  }
  // ---- Connecting Claude Code and Codex to Hydra (plan, Phase 5) ----
  private helperServerSpec(): HelperServerSpec { const bridge = this.helperBridge(); return { command: bridge.command, args: bridge.args, env: bridge.env }; }
  /** Claude's own CLI does the registration: the configured or PATH claude, else the extension's bundled one. */
  private async claudeForRegistration(): Promise<string | undefined> {
    const info = await findProvider('claude', vscode.workspace.getConfiguration('hydra').get<string>('claudePath')).catch(() => undefined);
    if (info?.executable) return info.executable;
    const extension = vscode.extensions.getExtension('anthropic.claude-code');
    if (!extension) return undefined;
    const bundled = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return await realpath(bundled).catch(() => undefined);
  }
  async helperConnections(): Promise<ProviderConnectionView[]> {
    const paths = providerPaths(), spec = this.helperServerSpec();
    const [claude, codex, memory] = await Promise.all([claudeStatus(paths, spec), codexStatus(paths.codexConfig, spec), claudeMemStatus()]);
    const accounts = this.accounts.snapshot();
    const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
    const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
    return [
      { ...claude, name: 'Claude Code', extensionInstalled: !!claudeExtension, extensionVersion: (claudeExtension?.packageJSON as { version?: string } | undefined)?.version, memory: memory.plugin && memory.bun && memory.dependencies ? 'ready' : 'missing', signedIn: accounts.claude.status },
      { ...codex, name: 'Codex', extensionInstalled: !!codexExtension, extensionVersion: (codexExtension?.packageJSON as { version?: string } | undefined)?.version, signedIn: accounts.codex.status },
    ];
  }
  /** "What Hydra wrote" (Settings, Connectors): the exact user-level entries read back off disk, secrets masked. */
  async helperWrittenEntries(): Promise<WrittenEntries> {
    return helperWrittenEntries(providerPaths(), maskSecret);
  }
  /** Re-run claude-mem's setup idempotently: the Repair button, and reused by Connect. */
  private async repairClaudeMem(): Promise<{ status: Awaited<ReturnType<typeof claudeMemStatus>>; installed: string[] }> {
    const claude = await this.claudeForRegistration();
    if (!claude) throw new Error('Install the Claude Code extension or CLI first.');
    return setupClaudeMem(claude);
  }
  /** Install an official extension from the gallery, or straight from Open VSX when this build has no gallery. */
  private async installProviderExtension(provider: ConnectableProvider): Promise<void> {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const id = provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt';
    if (vscode.extensions.getExtension(id)) return;
    try { await vscode.commands.executeCommand('workbench.extensions.installExtension', id); }
    catch (error) {
      if (!/gallery/i.test(this.describe(error))) throw error;
      this.output.appendLine(`[heads] no extension gallery; installing ${id} from Open VSX`);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(await downloadOpenVsx(id)));
    }
  }
  /**
   * One Connect: install the official extension if it's missing, connect it to
   * Hydra, and for Claude set up claude-mem too. A claude-mem problem doesn't undo
   * the connection; it's reported and Connect can be pressed again.
   */
  private async connectHelpers(provider: ConnectableProvider): Promise<string | undefined> {
    await this.installProviderExtension(provider);
    const paths = providerPaths(), spec = this.helperServerSpec();
    if (provider === 'codex') await connectCodex(paths.codexConfig, spec);
    else if (provider === 'claude') {
      const claude = await this.claudeForRegistration();
      if (!claude) throw new Error('Install the Claude Code extension or CLI first; Hydra connects through it.');
      await connectClaude(claude, paths, spec);
      this.output.appendLine('[heads] connected claude to Hydra');
      try {
        const memory = await setupClaudeMem(claude);
        if (memory.installed.length) this.output.appendLine(`[heads] set up ${memory.installed.join(' and ')} for claude-mem`);
        return undefined;
      } catch (error) { this.output.appendLine(`[heads] claude-mem setup failed: ${this.describe(error)}`); return `Connected, but claude-mem could not be set up: ${this.describe(error)}`; }
    } else throw new Error('Unknown provider.');
    this.output.appendLine(`[heads] connected ${provider} to Hydra`);
    return undefined;
  }
  private async disconnectHelpers(provider: ConnectableProvider): Promise<void> {
    const paths = providerPaths();
    if (provider === 'codex') await disconnectCodex(paths.codexConfig);
    else if (provider === 'claude') await disconnectClaude(await this.claudeForRegistration(), paths);
    else throw new Error('Unknown provider.');
    this.output.appendLine(`[heads] disconnected ${provider} from Hydra`);
  }
  /** A connection made by an older Hydra (a different executable path) is refreshed; nothing is connected here that the user didn't connect. */
  private async refreshHelperConnections(): Promise<void> {
    for (const connection of await this.helperConnections()) {
      if (connection.connected && !connection.current && !connection.error) {
        await this.connectHelpers(connection.provider).catch(error => this.output.appendLine(`[heads] could not refresh ${connection.provider}: ${this.describe(error)}`));
      }
    }
  }
  /** Dashboard actions: review a helper's changes as a diff, open its log, or cancel it. */
  private async helperAction(action: 'helperReview' | 'helperLog' | 'helperCancel', jobId: string): Promise<void> {
    const helpers = this.helpers;
    const job = helpers?.store.get(jobId);
    if (!helpers || !job) throw new Error('That head is not in this window.');
    if (action === 'helperCancel') { await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_cancel_head', { job_id: jobId, reason: 'Cancelled from the head dashboard.' }, new AbortController().signal); return; }
    if (action === 'helperLog') {
      const log = path.join(this.storageDirectory, 'helpers', 'logs', `${jobId}.jsonl`);
      await vscode.window.showTextDocument(vscode.Uri.file(log), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
    if (!job.worktree || !job.baseCommit) throw new Error('This head has no changes yet.');
    const head = job.result?.commit || (await git(job.worktree, ['rev-parse', 'HEAD'])).trim();
    const diff = await git(job.worktree, ['diff', '--stat', '--patch', '--no-color', job.baseCommit, head, '--']);
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content: `# ${job.title} (Hydra head ${job.id})\n# ${job.branch} ${job.baseCommit.slice(0, 12)}..${head.slice(0, 12)}\n# Merge it yourself with git when you're happy: git merge ${job.branch}\n\n${diff || '(no changes)'}` });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
  private async stopHelpers(): Promise<void> {
    const helpers = this.helpers; this.helpers = undefined;
    if (!helpers) return;
    await removeWindowRecord(helpers.record).catch(() => undefined);
    await helpers.service.dispose();
    await helpers.endpoint.close();
  }
  async showFirstRun(): Promise<void> {
    await this.collapseSidebarOnce();
    if (!this.disabled) await this.onboarding.autoShow(!!vscode.workspace.getConfiguration('hydra').get('handoff'));
  }
  private async collapseSidebarOnce(): Promise<void> {
    // The primary side bar has no configurationDefaults-controlled initial
    // visibility (unlike the secondary side bar), so a one-time explicit
    // close on first activation is the only extension-level way to start
    // with a clean, uncluttered layout. Only in the packaged desktop app,
    // and only once; the user's own later choice to reopen it is not undone.
    if (!this.settingsImport.available) return;
    const key = 'hydra.firstRunLayout.v1';
    if (this.context.globalState.get(key)) return;
    await this.context.globalState.update(key, true);
    await Promise.resolve(vscode.commands.executeCommand('workbench.action.closeSidebar')).catch(() => {});
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
  private async refresh(): Promise<void> { this.launchProbes.clear(); this.error = undefined; this.fileCache = undefined; if (!this.disabled && vscode.workspace.isTrusted) await this.capacity.refresh(); await this.refreshProviders(); await this.publish(); await this.scheduler.drain(); }
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
  private profileLimit(): number { return Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentProfileTasks', 2))); }
  private async settleCapacity(shutdown = false): Promise<void> {
    if (this.disabled || !vscode.workspace.isTrusted || this.closing && !shutdown) return;
    const owned = this.capacity.view(this.profileLimit()).owned;
    for (const [id, owner] of Object.entries(owned)) {
      const task = this.tasks.find(item => item.id === id);
      if (!task || this.resources.snapshot()[id]?.uncertain || this.managed.view(id)?.writerUncertain || task.schedule?.uncertain) { this.capacity.hold(id); continue; }
      if (owner.uncertain || this.busy || this.capacityStarting.has(id) || this.pendingResource?.id === id || this.managed.has(id) || this.terminals.has(id) || this.resources.has(id) || task.schedule?.state === 'starting') continue;
      await this.capacity.release(id);
    }
  }
  private async reconcileCapacity(task: Task): Promise<void> {
    const available = () => { if (this.busy || this.closing || this.disabled || this.handoff || !vscode.workspace.isTrusted || this.capacityStarting.has(task.id) || this.pendingResource?.id === task.id || this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.isActive(task.id)) throw new Error('Stop the owned writer and wait for task preparation before reconciling capacity.'); };
    available();
    const answer = await vscode.window.showWarningMessage('Confirm you stopped all surviving provider or setup processes for this task, including their children. Hydra cannot prove writer absence after restart or failed cleanup.', { modal: true }, 'All task writers stopped');
    if (answer !== 'All task writers stopped') return;
    available(); this.busy = true;
    try {
      if (this.resources.snapshot()[task.id]?.uncertain) await this.resources.reconcile(task.id);
      await this.managed.reconcile(task.id);
      if (task.schedule?.uncertain) await this.scheduler.reconcileStopped(task);
      else if (task.schedule?.request) await this.scheduler.cancel(task);
      if (task.state === 'running' || task.state === 'external' && task.interface === 'interactive-cli') task.state = 'interrupted';
      await this.persist(); await this.capacity.release(task.id, true);
    } finally { this.busy = false; await this.publish(); if (!this.closing) void this.scheduler.drain().catch(error => this.report(error)); }
  }
  private async persist(): Promise<void> {
    // Session completions can save unrelated tasks while discard/restore commits
    // an immutable record. Wait so an older snapshot cannot overwrite that record.
    await this.pendingDiscard?.catch(() => {});
    for (const task of this.tasks) {
      const s = task.schedule;
      if (this.managed.view(task.id)?.writerUncertain && s) { s.uncertain = true; s.reason = 'Owned process cleanup could not prove writer absence. Stop surviving children and reconcile explicitly.'; this.capacity.hold(task.id); }
      if (!s || !['running', 'waiting-for-approval'].includes(s.state)) continue;
      if (this.managed.has(task.id)) s.state = this.managed.view(task.id)?.approvals?.length ? 'waiting-for-approval' : 'running';
      else if (!this.terminals.has(task.id)) {
        s.state = task.state === 'idle' ? 'finished' : task.state === 'error' ? 'blocked' : 'interrupted';
        s.reason = task.error;
        if (s.state === 'finished' || s.state === 'interrupted') s.request = undefined;
      }
    }
    await this.store.save(this.tasks);
    await this.settleCapacity(); await this.publish();
    if (this.schedulerReady) queueMicrotask(() => { void this.scheduler.drain().catch(error => this.report(error)); });
  }
  /** Durable evidence commit deliberately excludes capacity and publish work. */
  private reviewBlocked(task: Task): boolean { return pendingSchedule(task) || this.busy || this.closing || this.disabled || !vscode.workspace.isTrusted || this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.has(task.id) || this.capacity.isUncertain(task.id) || task.state === 'running' || task.state === 'external'; }
  private async guardCommitReview(task: Task): Promise<void> {
    if (task.state === 'discarded') throw new Error('Restore this discarded task before review.');
    if (pendingSchedule(task)) throw new Error('Cancel queued work or reconcile the writer before reviewing or integrating this task.');
    if (this.closing || this.disabled || !vscode.workspace.isTrusted || this.handoff || this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.has(task.id) || this.capacity.isUncertain(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension') throw new Error('Stop the task writer and acknowledge external handback before preparing a commit review.');
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
    if (this.closing || this.disabled || this.handoff || !vscode.workspace.isTrusted || this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.has(task.id) || this.capacity.isUncertain(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension' || pendingSchedule(task) || task.schedule?.request) throw new Error('Stop task writers, cancel queued work, and reconcile uncertain ownership before discard or restore.');
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
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  /** One trailing publish for high-frequency updates; an immediate publish() supersedes it. */
  private publishSoon(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; void this.publish().catch(error => this.report(error)); }, 200);
  }
  private async publish(): Promise<void> {
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    const generation = ++this.snapshotGeneration;
    this.tree.changed.fire(undefined);
    const active = this.terminals.size + this.managed.count + this.resources.count;
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
    const resourceViews = this.resources.snapshot();
    let setupPreview: Snapshot['setupPreview'];
    if (task) { try { setupPreview = projectSelectedTaskSetupPreview(task, resourceViews); } catch (failure) { error ||= this.describe(failure); } }
    const snapshot: Snapshot = {
      tasks: this.tasks, selectedId: this.selectedId, mode: this.mode, repositories: this.repositories,
      conversationDraft: task ? this.conversationDrafts.get(task.id) : undefined,
      providers: this.providers, files, busy: this.busy || this.disabled, error, draft: this.draft,
      handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')),
      diagnostics: [...this.diagnostics.values()], session: task ? this.managed.displayView(task.id) : undefined,
      commitReview: task ? this.commitReviews.get(task.id) : undefined,
      discardReview: task ? this.discardReviews.get(task.id) : undefined,
      usage: usageSnapshot(this.tasks, id => this.managed.view(id)),
      budgets: this.budgetSnapshot(),
      helpers: this.helpers?.service.list().map(job => ({
        id: job.id, title: job.title, state: job.state, provider: job.provider, createdAt: job.createdAt, finishedAt: job.finishedAt,
        progress: job.progress, question: job.state === 'blocked' ? job.question : undefined, reason: job.state === 'running' ? undefined : job.reason,
        branch: job.branch, commit: job.result?.commit, summary: job.result?.summary, changedFiles: job.result?.changedFiles.length ?? 0,
        checks: job.result?.checks.map(check => ({ id: check.id, passed: check.passed })) ?? [],
        repository: this.helpers!.service.leadFolder, worktree: job.worktree, dependsOn: job.dependsOn,
      })).reverse(),
      resources: resourceViews,
      setupPreview,
      capacity: this.capacity.view(this.profileLimit()),
      modelCatalogs: Object.fromEntries(this.modelCatalogs),
      draftModelCatalogs: Object.fromEntries(this.draftModelCatalogs),
      integration: task ? this.integrationSnapshot(this.integrationOperations.get(task.id)) : undefined,
      taskActivity: Object.fromEntries(this.tasks.map(item => {
        const view = item.interface === 'managed-cli' ? this.managed.view(item.id) : undefined;
        return [item.id, { active: !!view?.active, awaitingApproval: !!view?.active && !!view.approvals?.length }];
      }))
    };
    await this.broadcast({ type: 'snapshot', snapshot });
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
  private async broadcast(message: unknown): Promise<void> {
    await Promise.all([this.panel?.webview.postMessage(message), this.conversation?.webview.postMessage(message)]);
  }
  private connectWebview(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(value => {
      void this.handle(value).then(async () => {
        // A direct receipt cannot be lost when a newer publish supersedes a draft snapshot.
        if (value?.type === 'conversationDraft') await webview.postMessage({ type: 'conversationDraftAck', id: value.id, version: value.version, draft: this.conversationDrafts.get(value.id) });
      }).catch(error => this.report(error));
    }, undefined, this.context.subscriptions);
  }
  private async openAgents(): Promise<void> {
    this.mode = 'agents';
    const modeChanged = vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('hydra.manager', 'Hydra · Agents', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
      });
      this.panel = panel;
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.mode = 'editor';
        void vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
        void this.publish();
      }, undefined, this.context.subscriptions);
      this.connectWebview(panel.webview);
    } else this.panel.reveal();
    await modeChanged;
    await this.publish();
  }
  private async openEditor(): Promise<void> {
    this.mode = 'editor';
    // Closing only Hydra lets native tab history restore text, diff and custom editors.
    // Never choose a sidebar, resize a group, or reopen a text document here.
    this.panel?.dispose();
    await vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    await this.publish();
  }
  private html(webview: vscode.Webview, surface: 'agents' | 'editor' = 'agents'): string {
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'hydra-logo.png'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Hydra</title></head><body data-surface="${surface}" data-logo="${logo}"><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  private async handle(value: unknown, scheduledLaunch = false): Promise<void> {
    const message = parseMessage(value);
    const expectedSchedule = scheduledLaunch && 'id' in message ? this.getTask(message.id).schedule : undefined;
    const assertLaunchCurrent = () => { if (scheduledLaunch && (!expectedSchedule || !('id' in message) || this.getTask(message.id).schedule !== expectedSchedule || expectedSchedule.state !== 'starting' || !expectedSchedule.request)) throw new Error('Queued launch cancelled before provider start.'); };
    if (message.type === 'ready') { await this.publish(); if (this.pendingNewTask) { this.pendingNewTask = false; await this.panel?.webview.postMessage({ type: 'newTask' }); } return; }
    if (message.type === 'openQuota') { this.quota.show(); return; }
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'agents') { await this.openAgents(); return; }
    if (message.type === 'newTask') { await vscode.commands.executeCommand('hydra.newTask'); return; }
    if (message.type === 'helperStopAll') { await vscode.commands.executeCommand('hydra.stopAllHelpers'); return; }
    if (message.type === 'helperReview' || message.type === 'helperLog' || message.type === 'helperCancel') { await this.helperAction(message.type, message.jobId); return; }
    // A reply draft changes on every keystroke. The typing panel gets its own ack
    // (conversationDraftAck) and send-time validation reads the draft map, which
    // updates here immediately; the publish only carries the draft to the other
    // panel. Publishing the whole snapshot per keystroke made typing lag, so it
    // is coalesced to one trailing publish once typing pauses.
    if (message.type === 'conversationDraft') { this.getTask(message.id); this.conversationDrafts.update(message.id, message); this.publishSoon(); return; }
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
    if (message.type === 'checkModelsForProvider') {
      if (this.draftModelCatalogs.get(message.provider)?.status === 'checking') throw new Error('This provider model check is already in progress.');
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.draftModelCatalogs.set(message.provider, { status: 'checking', models: [], checkedAt: new Date().toISOString() });
      await this.publish();
      try {
        const info = await findProvider(message.provider, vscode.workspace.getConfiguration('hydra').get<string>(`${message.provider}Path`));
        const cwd = this.repositories[0] || this.context.extensionUri.fsPath;
        const diagnostic = await checkProvider(info, cwd, controller.signal);
        if (!info.executable || diagnostic.status !== 'checked' || !supportedCliVersion(message.provider, diagnostic.version)) throw new Error(`Model discovery requires the configured official ${supportedCliDescription(message.provider)} executable.`);
        const models = await (message.provider === 'claude' ? discoverClaudeModels : discoverCodexModels)(info.executable, cwd, controller.signal);
        if (generation === this.diagnosticGeneration && !this.closing) this.draftModelCatalogs.set(message.provider, { status: 'ready', models, checkedAt: new Date().toISOString() });
      } catch (error) {
        if (generation === this.diagnosticGeneration && !this.closing) this.draftModelCatalogs.set(message.provider, { status: 'error', models: [], checkedAt: new Date().toISOString(), error: this.describe(error) });
      } finally { this.diagnosticChecks.delete(controller); await this.publish(); }
      return;
    }
    if (message.type === 'attachContext') {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: false, canSelectFiles: true, canSelectMany: true, openLabel: 'Attach' });
      if (!picked?.length) return;
      const root = this.repositories[0];
      const paths = picked.map(uri => root ? path.relative(root, uri.fsPath).split(path.sep).join('/') : uri.fsPath);
      await this.broadcast({ type: 'contextAttached', paths });
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
    if (this.handoff && ['create', 'handoff', 'launch', 'terminal', 'openWorktree', 'startManaged', 'followUp', 'prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'saveBudgets', 'retryBudgetHold', 'retryBlocked', 'saveResources', 'runSetup', 'releaseResources', 'reacquireResources', 'reconcileSetup', 'reconcileCapacity'].includes(message.type)) throw new Error('This window is an official-extension handoff. Manage task writers from the original Hydra window.');
    if (this.busy && ['create', 'handoff', 'releaseExternal', 'prepareCommitReview', 'commitReviewed', 'prepareIntegration', 'promoteIntegration', 'reviewIntegrationResolution', 'acceptIntegrationResolution', 'prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'launch', 'terminal', 'startManaged', 'followUp', 'configureSchedule', 'saveBrief', 'saveHandoffSummary', 'saveModelSelection', 'savePermissionMode', 'saveProviderSelection', 'saveBudgets', 'retryBudgetHold', 'retryBlocked', 'saveResources', 'runSetup', 'releaseResources', 'reacquireResources', 'reconcileSetup'].includes(message.type)) throw new Error('Another task operation is in progress.');
    if (message.type === 'create') {
      if (this.busy) throw new Error('Another task operation is in progress.');
      if (!this.repositories.includes(message.repository)) throw new Error('Choose an open workspace repository.');
      this.busy = true;
      await this.publish();
      let createdId: string | undefined;
      try {
        const id = randomBytes(6).toString('hex');
        const worktree = await createWorktree(message.repository, message.title, id, vscode.workspace.getConfiguration('hydra').get<string>('worktreeRoot'), message.startingCommit);
        const now = new Date().toISOString();
        this.tasks.push({ id, title: message.title.trim(), prompt: message.brief ? buildTaskPrompt(message.brief) : message.prompt.trim(), brief: message.brief, provider: message.provider,
          repository: message.repository, ...worktree, interface: 'interactive-cli', state: 'idle', createdAt: now, updatedAt: now });
        this.selectedId = id;
        createdId = id;
        this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
        await this.persist();
        await this.broadcast({ type: 'taskCreated' });
      } finally { this.busy = false; await this.publish(); if (this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
      // A single-prompt send creates the worktree and starts the agent in one step.
      // The task already exists, so a start failure is reported without discarding it.
      if (message.autoStart && createdId) {
        try { await this.handle({ type: 'startManaged', id: createdId }); }
        catch (error) { this.report(error); }
      }
      return;
    }
    if (!('id' in message)) throw new Error('Expected a task command.');
    const task = this.getTask(message.id);
    if (task.state === 'discarded' && !['select', 'copyDiscardLocation', 'restoreDiscarded', 'showSessionDiagnostics', 'releaseResources', 'showSetupLog', 'reconcileSetup', 'reconcileCapacity'].includes(message.type)) throw new Error('Restore this discarded task before continuing work.');
    if (message.type === 'reconcileCapacity') { await this.reconcileCapacity(task); return; }
    if (this.capacity.isUncertain(task.id) && ['launch', 'terminal', 'startManaged', 'followUp', 'configureSchedule', 'saveBrief', 'saveModelSelection', 'savePermissionMode', 'saveProviderSelection', 'saveResources', 'runSetup', 'releaseResources', 'reacquireResources', 'handoff', 'openWorktree', 'releaseExternal', 'prepareCommitReview', 'commitReviewed', 'prepareIntegration', 'promoteIntegration', 'reviewIntegrationResolution', 'acceptIntegrationResolution', 'prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'cancelQueued', 'retryBudgetHold', 'retryBlocked'].includes(message.type)) throw new Error('Stop surviving task writers and acknowledge this uncertain profile reservation first.');
    if (message.type === 'stopSetup') { const pending = this.pendingResource?.id === task.id ? this.pendingResource : undefined; pending?.controller.abort(); await pending?.done; await this.resources.stop(task.id); return; }
    if (message.type === 'showSetupLog') { const log = this.resources.snapshot()[task.id]?.log; if (!log) throw new Error('No setup diagnostics yet.'); await vscode.window.showTextDocument(vscode.Uri.file(log), { preview: true }); return; }
    if (['saveResources', 'runSetup', 'releaseResources', 'reacquireResources', 'reconcileSetup'].includes(message.type)) {
      if (this.busy || this.handoff || pendingSchedule(task) || task.schedule?.request || this.terminals.has(task.id) || this.managed.has(task.id) || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension' || this.integrationAbort?.taskId === task.id || this.tasks.some(item => item.schedule?.state === 'starting' && item.schedule.dependencies.includes(task.id))) throw new Error('Stop writers and cancel queued work before resource setup.');
      if (message.type === 'reconcileSetup') {
        const answer = await vscode.window.showWarningMessage('Confirm you stopped any surviving setup process and its children. Hydra cannot prove writer absence after restart.', { modal: true }, 'Setup stopped');
        if (answer === 'Setup stopped') { await this.resources.reconcile(task.id); await this.capacity.release(task.id, true); } return;
      }
      if (this.resources.has(task.id)) throw new Error('Stop setup and reconcile uncertain ownership first.');
      if ((message.type === 'saveResources' || message.type === 'releaseResources') && task.state !== 'discarded' && !canEditBrief(task, this.managed.view(task.id))) throw new Error('Resources are locked after launch. Discard the task before releasing its reservations.');
      this.busy = true;
      const setupController = new AbortController(); let completeResource!: () => void;
      this.pendingResource = { id: task.id, controller: setupController, done: new Promise<void>(resolve => { completeResource = resolve; }) };
      try {
        if (message.type === 'saveResources') await this.resources.configure(task.id, message.config);
        else if (message.type === 'releaseResources') await this.resources.release(task.id);
        else if (message.type === 'reacquireResources') await this.resources.reacquire(task.id);
        else if (message.type === 'runSetup') {
          const guard = async (item: Task = task) => {
            if (setupController.signal.aborted || this.closing || this.disabled || !vscode.workspace.isTrusted || this.handoff || pendingSchedule(item) || this.terminals.has(item.id) || this.managed.has(item.id) || item.state === 'external' || item.state === 'running' || item.state === 'discarded' || item.id !== task.id && this.resources.has(item.id)) throw new Error('Setup requires exclusive access to a trusted task checkout.');
            await this.verifyWorktree(item);
            const root = await realpath(item.worktree);
            if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && isInside(root, document.uri.fsPath))) throw new Error('Save or revert task buffers before setup.');
          };
          const max = Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2)));
          if (this.terminals.size + this.managed.count + this.resources.count >= max) throw new Error('The task concurrency limit is reached.');
          if (!await this.capacity.tryAcquire(task.id, 'setup', this.profileLimit())) throw new Error('The shared profile task capacity is reached.');
          const prepared = await prepareScheduledTask(task, this.tasks, guard);
          if (task.schedule) { task.schedule.actualStartingCommit = prepared.commit; task.schedule.artifacts = prepared.artifacts; }
          await this.persist(); await this.resources.start(task.id, task.worktree, async () => { await guard(); await this.capacity.check(task.id, this.profileLimit()); if (setupController.signal.aborted || this.closing || this.disabled || !vscode.workspace.isTrusted) throw new Error('Setup startup cancelled.'); });
        }
      } finally { this.pendingResource = undefined; completeResource(); this.busy = false; await this.settleCapacity(); await this.publish(); if (!this.closing && this.schedulerReady) void this.scheduler.drain().catch(error => this.report(error)); }
      return;
    }
    if (this.resources.has(task.id) && ['configureSchedule', 'saveBrief', 'saveModelSelection', 'savePermissionMode', 'saveProviderSelection', 'handoff', 'openWorktree'].includes(message.type)) throw new Error('Stop setup and reconcile its writer first.');
    if (['handoff', 'openWorktree'].includes(message.type) && this.resources.snapshot()[task.id]) throw new Error('Configured task resources are supported in Hydra managed sessions and provider terminals. Use those interfaces for this task.');
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
    if (message.type === 'retryBlocked') {
      if (this.managed.has(task.id) || this.terminals.has(task.id)) throw new Error('Stop this writer before retrying.');
      await this.scheduler.retryBlocked(task); return;
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
    if (task.modelSelection && ['launch', 'terminal', 'handoff', 'openWorktree'].includes(message.type)) throw new Error(`This task has an explicit managed ${task.provider === 'codex' ? 'Codex' : 'Claude'} model selection. Start it with Run managed task; terminal and official-extension settings cannot be verified by Hydra. Clear the selection before its first launch to use those interfaces.`);
    if (message.type === 'saveModelSelection') {
      if (this.busy || !canEditBrief(task, this.managed.view(task.id))) throw new Error('Model settings are locked after launch. Create a new task to use another selection.');
      if (message.selection) {
        const catalog = this.modelCatalogs.get(task.id);
        if (catalog?.status !== 'ready') throw new Error('Load available provider models before saving a selection.');
        if (task.provider === 'claude') requireClaudeSelection(catalog.models, message.selection);
        else requireAdvertisedSelection(catalog.models, message.selection);
      }
      task.modelSelection = message.selection || undefined; task.updatedAt = new Date().toISOString();
      await this.persist(); await this.publish(); return;
    }
    if (message.type === 'savePermissionMode') {
      if (this.busy || !canEditBrief(task, this.managed.view(task.id))) throw new Error('Permission mode is locked after launch. Create a new task to run under another mode.');
      if (message.permissionMode && message.permissionMode.provider !== task.provider) throw new Error(`This is a ${task.provider} task; it cannot take a ${message.permissionMode.provider} permission mode.`);
      task.permissionMode = message.permissionMode || undefined; task.updatedAt = new Date().toISOString();
      await this.persist(); await this.publish(); return;
    }
    if (message.type === 'saveProviderSelection') {
      // A session belongs to one provider, so provider and model are fixed once the
      // task launches. Before that, switching provider drops the settings that only
      // meant something to the old one, and a model is checked against the catalog
      // the picker was actually showing.
      if (this.busy || !canEditBrief(task, this.managed.view(task.id))) throw new Error('Provider and model are locked after launch. Create a new task to use another provider.');
      let catalog: ModelCatalog | undefined;
      if (message.selection) {
        catalog = this.draftModelCatalogs.get(message.provider);
        if (catalog?.status !== 'ready') throw new Error('Load available provider models before saving a selection.');
        if (message.provider === 'claude') requireClaudeSelection(catalog.models, message.selection);
        else requireAdvertisedSelection(catalog.models, message.selection);
      }
      if (message.provider !== task.provider) task.permissionMode = undefined;
      if (catalog) this.modelCatalogs.set(task.id, catalog); else if (message.provider !== task.provider) this.modelCatalogs.delete(task.id);
      task.provider = message.provider; task.modelSelection = message.selection || undefined; task.updatedAt = new Date().toISOString();
      await this.persist(); await this.publish(); return;
    }
    if (message.type === 'checkModels') {
      if (this.busy || this.modelCatalogs.get(task.id)?.status === 'checking') throw new Error('Another task or model check is in progress.');
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.modelCatalogs.set(task.id, { status: 'checking', models: [], checkedAt: new Date().toISOString() });
      await this.publish();
      try {
        await this.verifyWorktree(task);
        const info = await findProvider(task.provider, vscode.workspace.getConfiguration('hydra').get<string>(`${task.provider}Path`));
        const diagnostic = await checkProvider(info, task.worktree, controller.signal);
        if (!info.executable || diagnostic.status !== 'checked' || !supportedCliVersion(task.provider, diagnostic.version)) throw new Error(`Model discovery requires the configured official ${supportedCliDescription(task.provider)} executable.`);
        const models = await (task.provider === 'claude' ? discoverClaudeModels : discoverCodexModels)(info.executable, task.worktree, controller.signal);
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
      if (this.busy || this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.has(task.id) || this.capacity.isUncertain(task.id) || task.state === 'external' || task.state === 'running') throw new Error('Stop this writer before editing dependencies.');
      const candidate = structuredClone(task);
      configureSchedule(candidate, this.tasks, message.dependencies, message.startFromDependency);
      this.busy = true;
      try { await this.resources.invalidate(task.id); task.schedule = candidate.schedule; await this.persist(); }
      finally { this.busy = false; await this.publish(); if (this.schedulerReady && !this.closing) void this.scheduler.drain().catch(error => this.report(error)); }
      return;
    }
    if (message.type === 'cancelQueued') { if (this.managed.has(task.id) || this.terminals.has(task.id)) throw new Error('Stop the owned writer first.'); await this.scheduler.cancel(task); return; }
    if (message.type === 'reconcileWriter') {
      if (this.terminals.has(task.id) || this.managed.has(task.id) || this.resources.has(task.id)) throw new Error('Stop the owned writer first.');
      const answer = await vscode.window.showWarningMessage('Confirm you have stopped any surviving provider process for this task. Hydra cannot prove writer absence after a restart.', { modal: true }, 'Writer stopped');
      if (answer === 'Writer stopped') { await this.managed.reconcile(task.id); await this.scheduler.reconcileStopped(task); await this.capacity.release(task.id, true); }
      return;
    }
    if (!scheduledLaunch && ['launch', 'terminal', 'startManaged', 'followUp'].includes(message.type)) {
      if (message.type === 'startManaged' || message.type === 'followUp') { this.sendStarted.set(task.id, Date.now()); this.mark(task.id, `${message.type} received`); }
      if (message.type === 'followUp' && message.draftVersion) this.conversationDrafts.requireCurrent(task.id, message.prompt, message.draftVersion);
      if (this.integrationAbort?.taskId === task.id) throw new Error('Finish or cancel this task integration before queueing another writer.');
      if ((message.type === 'launch' || message.type === 'terminal') && this.terminals.has(task.id)) { this.terminals.get(task.id)!.show(false); return; }
      assertCliAllowed(task);
      if (this.managed.has(task.id)) throw new Error('Stop the managed process before queueing another launch.');
      if (this.terminals.has(task.id) || task.state === 'external' || task.state === 'running') throw new Error('Stop this task writer before queueing another launch.');
      if (message.type === 'startManaged' && task.sessionId) throw new Error('Send a follow-up to resume this session.');
      if (message.type === 'followUp' && !task.sessionId) throw new Error('Start the task before sending a follow-up.');
      await this.resources.check(task.id); this.mark(task.id, 'resources checked');
      await lockTaskContext(task, () => this.persist()); this.mark(task.id, 'context locked and saved');
      await this.scheduler.enqueue(task, message.type === 'followUp' ? { type: 'followUp', prompt: message.prompt } : { type: message.type as 'launch' | 'terminal' | 'startManaged' });
      if (message.type === 'followUp' && message.draftVersion) {
        this.conversationDrafts.accepted(task.id, message.prompt, message.draftVersion);
        await this.publish();
      }
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
      if (this.terminals.size + this.managed.count + this.resources.count >= max) throw new Error('The task concurrency limit is reached. Stop a task writer first.');
      this.busy = true;
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.mark(task.id, 'scheduler launching');
      try {
        const info = await findProvider(task.provider, vscode.workspace.getConfiguration('hydra').get<string>(`${task.provider}Path`));
        if (!info.executable) throw new Error(`${task.provider} CLI not found. Set its executable path first.`);
        this.mark(task.id, 'provider found');
        // Probe before a model request unless this exact binary (path, size, mtime,
        // ctime) already passed: cached help must not authorize a changed binary.
        // Re-probing an unchanged one on every send cost ~0.65s per message.
        const fingerprint = await executableFingerprint(info.executable);
        const probed = this.launchProbes.get(task.provider);
        const diagnostic = probed?.fingerprint === fingerprint ? probed.diagnostic : await checkProvider(info, task.worktree, controller.signal);
        if (diagnostic.status === 'checked') this.launchProbes.set(task.provider, { fingerprint, diagnostic }); else this.launchProbes.delete(task.provider);
        this.mark(task.id, 'provider probed');
        if (controller.signal.aborted || this.closing || generation !== this.diagnosticGeneration) throw new Error('Managed startup cancelled because the window closed or provider configuration changed.');
        this.diagnostics.set(task.provider, diagnostic);
        if (diagnostic.status !== 'checked' || !supportedCliVersion(task.provider, diagnostic.version)) throw new Error(`Managed sessions support ${supportedCliDescription(task.provider)}. Use the terminal for another version; see provider diagnostics.`);
        assertLaunchCurrent();
        this.checkBudget(task, true);
        await this.resources.check(task.id);
        task.providerVersion = diagnostic.version;
        task.updatedAt = new Date().toISOString();
        this.mark(task.id, 'resources and budget checked');
        // This task-store write is intentionally before Managed* can spawn or submit a provider turn.
        await this.persist();
        this.mark(task.id, 'saved; starting provider');
        const normalPrompt = message.type === 'followUp' ? message.prompt : task.prompt;
        await this.managed.start(task, info.executable, normalPrompt, async () => {
          await this.capacity.check(task.id, this.profileLimit()); await this.resources.check(task.id);
          if (controller.signal.aborted || this.closing || this.disabled || !vscode.workspace.isTrusted || generation !== this.diagnosticGeneration) throw new Error('Managed startup cancelled because workspace or provider configuration changed.');
          if (scheduledLaunch && (task.schedule !== expectedSchedule || !expectedSchedule?.request || !['starting', 'running', 'waiting-for-approval'].includes(expectedSchedule.state))) throw new Error('Queued managed turn cancelled before provider submission.');
          this.checkBudget(task, true); this.resources.assertReady(task.id);
        }, this.resources.environment(task.id));
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
      if (this.terminals.size + this.managed.count + this.resources.count >= max) throw new Error(`The ${max}-task concurrency limit is reached. Stop a task writer before launching another.`);
      await this.refreshProviders();
      const provider = this.providers.find(item => item.provider === task.provider);
      if (!provider?.executable) throw new Error(`${task.provider} CLI not found. Install it or set Hydra's ${task.provider} path. Authentication remains with the official CLI.`);
      // Recheck after async probes to prevent simultaneous webview launches exceeding the limit.
      if (this.busy) throw new Error('Another task operation is in progress.');
      assertCliAllowed(task);
      if (this.managed.has(task.id)) throw new Error('Stop the managed process before opening a terminal writer.');
      const duplicate = this.terminals.get(task.id);
      if (duplicate) { duplicate.show(false); return; }
      if (this.terminals.size + this.managed.count + this.resources.count >= max) throw new Error('The task concurrency limit is reached.');
      assertLaunchCurrent();
      this.checkBudget(task, true);
      await this.resources.check(task.id); await this.capacity.check(task.id, this.profileLimit());
      if (this.busy || this.closing || this.disabled || !vscode.workspace.isTrusted) throw new Error('Terminal startup cancelled because workspace availability changed.');
      if (this.terminals.size + this.managed.count + this.resources.count >= max) throw new Error('The task concurrency limit is reached.');
      assertLaunchCurrent(); this.checkBudget(task, true); this.resources.assertReady(task.id);
      const terminal = vscode.window.createTerminal({ env: this.resources.environment(task.id), name: `Hydra · ${task.title}`, cwd: task.worktree, ...terminalLaunch(provider.executable), isTransient: true });
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
    await this.stopHelpers().catch(error => this.report(error));
    this.pendingResource?.controller.abort(); await this.pendingResource?.done;
    await this.accounts.shutdown();
    await this.quota.shutdown();
    this.integrationAbort?.controller.abort();await this.pendingIntegration?.catch(()=>{});
    await this.pendingCommit?.catch(() => {});
    await this.pendingDiscard?.catch(() => {});
    await this.pendingBudgetSave?.catch(() => {});
    for (const controller of this.diagnosticChecks) controller.abort();
    await this.scheduler.idle();
    await this.resources.shutdown();
    await this.managed.shutdown();
    this.scheduler.reconcile();
    for (const [id, terminal] of this.terminals) {
      terminal.dispose();
      const task = this.getTask(id);
      task.state = 'interrupted';
      task.updatedAt = new Date().toISOString();
    }
    try { await this.settleCapacity(true).catch(error => this.report(error)); if (!this.disabled) await this.store.save(this.tasks); }
    finally { await this.capacity.shutdown(); for (const lock of this.locks) await lock.release(); }
  }
  private getIntegration(task:Task,id:string):IntegrationOperation{
    const op=this.integrationOperations.get(task.id);
    if(!op||op.id!==id)throw new Error('Integration operation expired. Select the current candidate.');
    return op;
  }
}
