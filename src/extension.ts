import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { OwnershipLock } from './core/ownership';
import { git, repositoryRoot } from './core/worktrees';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { ProviderAccounts } from './extensionAccounts';
import { ProviderQuota } from './extensionQuota';
import { findProvider } from './core/providers';
import { JobStore, finalJobStates, resolveHeadDefaults } from './core/jobs';
import { HelperEndpoint } from './core/helperEndpoint';
import { HelperService } from './core/helperService';
import { removeWindowRecord, writeWindowRecord } from './core/helperDiscovery';
import { startHelperRun } from './core/helperRunner';
import { createLeadVerifier } from './core/leadVerification';
import { claudeMemStatus, setupClaudeMem } from './core/claudeMem';
import { downloadOpenVsx } from './core/openVsx';
import { selfCheckCli } from './core/cliSelfCheck';
import { claudeStatus, codexStatus, connectClaude, connectCodex, disconnectClaude, disconnectCodex, helperWrittenEntries, providerPaths, read, runClaude, setClaudeLimitHook, type ConnectableProvider, type HelperServerSpec, type WrittenEntries } from './core/helperRegistration';
import { claudeSupportsLimitHook, limitHookGroup, limitHookState, type LimitHookGroup } from './core/claudeLimitHook';
import type { LimitEvent } from './core/limitEvents';
import { ClaudeChatLimits, CodexChatLimits } from './extensionLimits';
import type { ProviderConnectionView } from './helperConnectionsView';
import { addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, maskSecret, removeMcpServer, testMcpServer, validateServerSpec, type McpAgent } from './core/mcpServers';
import { checkProvider } from './core/diagnostics';
import { settingsRequiringRefresh } from './core/settingsRefresh';
import { parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { claudeForRegistration } from './claudeExecutable';
import { registerChatLocationController, setChatLocation } from './chatLocationController';
import { registerLimitOffer } from './extensionLimitOffer';
import { LanesController, isLaneMessage } from './extensionLanes';
import { HydraTreeProvider } from './extensionTree';
import { parseMessage, type HelperJobView, type Provider, type ProviderDiagnostic, type Snapshot, type Handoff, type HandoffTask } from './core/model';
// ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4). Its own block; Phase 1 (Lanes) wires its own imports separately. ----
import { createPlan, maxPlanJobs, PlanStore, runPlan, type Plan, type PlanJob } from './core/plans';
import { planBrief } from './core/planner';

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

class Manager {
  private repositories: string[] = [];
  private panel?: vscode.WebviewPanel;
  /** hydra.newPlan on a panel that is still loading: shown once its webview says it is ready. */
  private pendingNewPlan = false;
  private mode: 'editor' | 'agents' = 'editor';
  private busy = false;
  private error?: string;
  private disabled = false;
  private closing = false;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel('Hydra');
  private readonly locks: OwnershipLock[] = [];
  private readonly storageDirectory: string;
  /** Hydra helpers for this window (docs/Official_Extensions_Plan.md): job store, local endpoint, service, discovery record. */
  private helpers?: { store: JobStore; endpoint: HelperEndpoint; service: HelperService; record: string };
  // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own store, and the brief-planning ----
  // ---- CLI runs in flight (by plan id), so Cancel and window close can abort them. ----
  private plans?: { store: PlanStore; planning: Map<string, AbortController> };
  private readonly leadKey: string;
  private snapshotGeneration = 0;
  private handoff?: Handoff;
  private readonly diagnostics = new Map<Provider, ProviderDiagnostic>();
  private readonly diagnosticChecks = new Set<AbortController>();
  private diagnosticGeneration = 0;
  private readonly settings: AppearanceSettings;
  private readonly settingsImport: SettingsImport;
  private readonly onboarding: Onboarding;
  private readonly accounts: ProviderAccounts;
  private readonly quota: ProviderQuota;
  /**
   * Every usage limit Hydra notices (docs/Hydra_Agent_Plan.md, Phase 1): Claude chats
   * (StopFailure hook), Codex chats (rate-limit polling) and heads. The handoff UI
   * subscribes with `limitEvents.event(listener)`.
   */
  readonly limitEvents = new vscode.EventEmitter<LimitEvent>();
  // ---- Lanes (docs/Lanes_And_Planner_Plan.md): state; the methods are in the Lanes block below ----
  private readonly lanes: LanesController;
  /** The Hydra activity-bar panel (section 3): one TreeView over lanes, heads and plans. */
  private readonly tree = new HydraTreeProvider();
  /** The Agents panel whose webview has sent "ready". */
  private readyPanel?: vscode.WebviewPanel;
  /** The window's discovery record lists its folders plus open lanes' worktrees. */
  private discovery?: { port: number; folders: string[]; written: string; queue: Promise<void> };
  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsImport = new SettingsImport(context);
    this.accounts = new ProviderAccounts(context, this.settingsImport.available);
    this.quota = new ProviderQuota(context, this.settingsImport.available);
    this.settings = new AppearanceSettings(context, this.settingsImport);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings);
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota, this.limitEvents, this.tree);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.leadKey = key;
    this.lanes = new LanesController({
      context, log: line => this.output.appendLine(line),
      post: message => { void this.panel?.webview.postMessage(message); },
      openAgents: () => this.openAgents(), webviewReady: () => !!this.panel && this.readyPanel === this.panel,
      helperServerSpec: provider => this.helperServerSpec(provider), runningHeads: id => this.laneHeads(id),
      changed: () => this.laneFoldersChanged(),
    });
    context.subscriptions.push(this.lanes);
  }
  async initialize(): Promise<void> {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, (...args) =>
      Promise.resolve().then(() => callback(...args)).catch(error => { this.report(error); throw error; })));
    command('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    command('hydra.openAgents', () => this.openAgents());
    // Not contributed: desktop builds made before the walkthrough change still link "New Task"
    // here, so it opens the Agents view.
    command('hydra.newTask', () => this.openAgents());
    command('hydra.openSettings', (pageId?: string) => this.settings.show(pageId));
    command('hydra.setChatLocation', (mode?: 'docked' | 'tabs') => setChatLocation(mode));
    command('hydra.getLayoutMode', () => ({ mode: this.mode }));
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
    command('hydra.stopAllHelpers', async () => {
      const stopped = await this.helpers?.service.stopAll() ?? 0;
      void vscode.window.showInformationMessage(stopped ? `Stopped ${stopped} Hydra head${stopped === 1 ? '' : 's'}.` : 'No Hydra heads are running.');
      return stopped;
    });
    command('hydra.listHelpers', () => structuredClone(this.helpers?.service.list() ?? []));
    // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4). newPlan is public; the plans.* commands are test-only, not in menus. ----
    command('hydra.newPlan', () => this.newPlan());
    command('hydra.plans.list', () => structuredClone(this.plans?.store.list() ?? []));
    command('hydra.plans.save', async (plan: unknown) => { const saved = await this.requirePlans().store.save(plan as Plan); this.plansChanged(); return saved; });
    command('hydra.plans.run', async (id: unknown) => { await this.runPlanById(String(id)); return structuredClone(this.requirePlans().store.get(String(id))); });
    command('hydra.helperConnections', () => this.helperConnections());
    command('hydra.connectHelpers', async (provider: ConnectableProvider) => ({ warning: await this.connectHelpers(provider), connections: await this.helperConnections() }));
    command('hydra.disconnectHelpers', async (provider: ConnectableProvider) => { await this.disconnectHelpers(provider); return this.helperConnections(); });
    command('hydra.installProviderExtension', async (provider: ConnectableProvider) => { await this.installProviderExtension(provider); return this.helperConnections(); });
    command('hydra.repairClaudeMem', () => this.repairClaudeMem());
    command('hydra.helperWrittenEntries', () => this.helperWrittenEntries());
    // MCP servers (Settings plan, Phase 4). Lists come back with secrets masked; changes return the fresh list.
    const mcp = async () => defaultMcpContext(await claudeForRegistration());
    command('hydra.mcpServers.list', async () => listMcpServers(await mcp()));
    command('hydra.mcpServers.add', async (name: unknown, spec: unknown, agents: unknown) => { const context = await mcp(); await addMcpServer(context, name, spec, agents); return listMcpServers(context); });
    command('hydra.mcpServers.remove', async (name: unknown, agent: unknown) => { const context = await mcp(); await removeMcpServer(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.enable', async (name: unknown, agent: unknown) => { const context = await mcp(); await enableMcpServerFor(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.test', async (target: unknown, agent?: McpAgent) => testMcpServer(typeof target === 'string' ? await configuredSpec(await mcp(), target, agent) : validateServerSpec(target)));
    command('hydra.openOfficialExtension', () => this.handle({ type: 'openOfficial' }));
    command('hydra.getHandoff', () => structuredClone(this.handoff));
    command('hydra.checkProvider', async (provider?: string) => {
      provider ||= vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude');
      await this.handle({ type: 'checkProvider', provider });
      return structuredClone(this.diagnostics.get(provider as Provider));
    });
    command('hydra.getProviderDiagnostics', () => structuredClone([...this.diagnostics.values()]));
    this.lanes.registerCommands(command);
    // ---- The Hydra panel (docs/Lanes_And_Planner_Plan.md, section 3) ----
    this.context.subscriptions.push(vscode.window.createTreeView('hydra.overview', { treeDataProvider: this.tree }));
    command('hydra.overview.mergeLane', (row: { item?: { id?: string } } = {}) => row.item?.id && this.lanes.action(row.item.id, 'merge', true));
    command('hydra.overview.closeLane', (row: { item?: { id?: string } } = {}) => row.item?.id && this.lanes.action(row.item.id, 'close', true));
    // Not in the palette: fires a made-up limit event, for the handoff UI and smoke tests.
    command('hydra.debug.simulateLimit', (provider: unknown = 'claude', source: unknown = 'chat') => {
      if ((provider !== 'claude' && provider !== 'codex') || (source !== 'chat' && source !== 'head')) throw new Error('simulateLimit takes provider "claude" or "codex" and source "chat" or "head".');
      const folder = vscode.workspace.workspaceFolders?.[0];
      const event: LimitEvent = { provider, source, at: new Date().toISOString(), message: 'Simulated usage limit (hydra.debug.simulateLimit).', ...(folder ? { cwd: folder.uri.fsPath } : {}) };
      this.limitEvents.fire(event);
      return event;
    });
    this.context.subscriptions.push(this.limitEvents.event(event => this.output.appendLine(`[limits] ${event.provider} ${event.source}${event.jobId ? ` ${event.jobId}` : ''}${event.sessionId ? ` session ${event.sessionId}` : ''}${event.resetsAt ? `, resets ${event.resetsAt}` : ''}: ${event.message ?? 'usage limit reached'}`)));
    this.context.subscriptions.push(this.status, this.output);
    await vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    this.status.command = 'hydra.toggleMode';
    this.status.show();
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('hydra')) return;
      // Preference-only settings (the head cap) are read fresh wherever they are
      // used, so they only republish. Any other Hydra setting, including ones
      // added later, clears provider checks and refreshes.
      if (!otherHydraSettings(this.context).some(key => event.affectsConfiguration(key))) { void this.publish().catch(error => this.report(error)); return; }
      this.diagnosticGeneration++; this.diagnostics.clear();
      for (const controller of this.diagnosticChecks) controller.abort();
      void this.refresh().catch(error => this.report(error));
    }));
    try {
      await this.refreshRepositories();
      if (vscode.workspace.isTrusted) {
        // Lock each canonical repository, so different workspace configurations cannot own the same repo.
        for (const repository of [...this.repositories].sort()) {
          const lock = new OwnershipLock();
          await lock.acquire(path.join(this.context.globalStorageUri.fsPath, 'ownership'), repository);
          this.locks.push(lock);
        }
      }
    } catch (error) { this.disabled = true; this.report(error); }
    try {
      this.handoff = parseHandoff(vscode.workspace.getConfiguration('hydra').get('handoff'));
      if (this.handoff) { await this.verifyHandoffWorkspace(); await this.openAgents(); }
    } catch (error) { this.disabled = true; this.report(error); }
    await this.startHelpers().catch(error => { this.output.appendLine(`[heads] not started: ${this.describe(error)}`); });
    this.startLimitDetection();
    this.context.subscriptions.push(registerLimitOffer({
      limitEvents: this.limitEvents.event,
      storageDir: this.context.globalStorageUri.fsPath,
      offerEnabled: () => vscode.workspace.getConfiguration('hydra').get<boolean>('limits.offerHandoff', true),
      job: jobId => this.helpers?.store.get(jobId),
      otherReady: async provider => (await this.helperConnections()).find(connection => connection.provider === provider)?.connected ?? false,
      continueWith: async (jobId, provider, markdown) => {
        if (!this.helpers) throw new Error('Hydra heads are still starting.');
        await this.helpers.service.continueWith(jobId, provider, markdown);
      },
      log: line => this.output.appendLine(line),
    }));
    await this.publish();
  }
  private get limitEventsDirectory(): string { return path.join(this.context.globalStorageUri.fsPath, 'limit-events'); }
  /** Claude's StopFailure hook: this editor's executable as Node, running dist/hydra-limit-hook.cjs into the shared events folder. */
  private limitHook(): LimitHookGroup {
    return limitHookGroup({ executable: process.execPath, script: path.join(this.context.extensionPath, 'dist', 'hydra-limit-hook.cjs'), eventsDir: this.limitEventsDirectory });
  }
  /** The hook, if this Claude runs exec-form hooks (2.1.139+); older ones would run it through a shell. */
  private async limitHookFor(claude: string): Promise<LimitHookGroup | undefined> {
    const version = await runClaude(claude, ['--version']);
    if (version.code === 0 && claudeSupportsLimitHook(version.output)) return this.limitHook();
    this.output.appendLine('[limits] Claude Code is older than 2.1.139; its usage-limit hook is not installed.');
    return undefined;
  }
  /** Chats in the official extensions: Claude's hook events and Codex's polled limits. Heads report through their service. */
  private startLimitDetection(): void {
    if (this.handoff || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    const fire = (event: LimitEvent) => this.limitEvents.fire(event);
    const claude = new ClaudeChatLimits(this.limitEventsDirectory, providerPaths().claudeProjects, fire);
    this.context.subscriptions.push(claude);
    void claude.start().catch(error => this.output.appendLine(`[limits] Claude chat limits not watched: ${this.describe(error)}`));
    this.context.subscriptions.push(new CodexChatLimits(this.quota, async () =>
      this.settingsImport.available && vscode.workspace.isTrusted && !!vscode.extensions.getExtension('openai.chatgpt') && (await codexStatus(providerPaths().codexConfig, this.helperServerSpec('codex'))).connected,
    fire, line => this.output.appendLine(line)));
  }
  /** How a CLI starts Hydra's stdio bridge: this editor's executable as Node, running dist/hydra-mcp.cjs. */
  helperBridge(provider?: ConnectableProvider): { command: string; args: string[]; env: Record<string, string> } {
    return { command: process.execPath, args: [path.join(this.context.extensionPath, 'dist', 'hydra-mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: path.join(this.context.globalStorageUri.fsPath, 'helpers'), ...(provider ? { HYDRA_LEAD_PROVIDER: provider } : {}) } };
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
    const store = new JobStore(directory, undefined, undefined, () => {
      const config = vscode.workspace.getConfiguration('hydra');
      return resolveHeadDefaults({
        minutes: config.get<number>('heads.defaultMinutes'),
        maxTurns: config.get<number>('heads.defaultMaxTurns'),
        budgetUsd: config.get<number>('heads.defaultBudgetUsd'),
      });
    });
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
    }, { leadKey, laneExists: id => this.lanes.exists(id), verifyLead: async socket => {
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
      onChange: () => this.headsChanged(), log: line => this.output.appendLine(line),
      lanes: { describe: you => this.lanes.describe(you), name: id => this.lanes.laneName(id) },
    });
    this.context.subscriptions.push(service.onLimit(event => this.limitEvents.fire(event)));
    await service.recover();
    await this.lanes.start(leadFolder, this.storageDirectory).catch(error => this.output.appendLine(`[lanes] not started: ${this.describe(error)}`));
    const record = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port, pid: process.pid, folders: [...folders, ...this.lanes.openWorktrees()] });
    this.discovery = { port, folders, written: JSON.stringify(this.lanes.openWorktrees()), queue: Promise.resolve() };
    this.helpers = { store, endpoint, service, record };
    // Plans need the same trusted repository as heads (they read it, and running one starts heads in it).
    const planStore = new PlanStore(path.join(this.storageDirectory, 'plans'));
    await planStore.load();
    this.plans = { store: planStore, planning: new Map() };
    this.tree.update({ lanes: this.lanes.state().lanes, heads: this.headViews() ?? [], plans: planStore.list() });
    this.output.appendLine(`[heads] ready for ${leadFolder}`);
    void this.refreshHelperConnections();
  }
  // ---- Lanes (docs/Lanes_And_Planner_Plan.md). The editor side is LanesController (src/extensionLanes.ts). ----
  /** Unfinished heads started from a lane. */
  private laneHeads(laneId: string): number {
    return this.helpers?.service.list().filter(job => job.lead?.lane === laneId && !finalJobStates.has(job.state)).length ?? 0;
  }
  /**
   * Rewrite the discovery record when the open lanes' worktrees change, so a
   * lane's bridge finds this window from inside its worktree. The old record goes.
   */
  private laneFoldersChanged(): void {
    this.tree.update({ lanes: this.lanes.state().lanes });
    const discovery = this.discovery;
    if (!discovery) return;
    const worktrees = this.lanes.openWorktrees(), key = JSON.stringify(worktrees);
    if (key === discovery.written) return;
    discovery.written = key;
    discovery.queue = discovery.queue.then(async () => {
      const helpers = this.helpers;
      if (!helpers || this.discovery !== discovery) return;
      const next = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port: discovery.port, pid: process.pid, folders: [...discovery.folders, ...worktrees] });
      if (next !== helpers.record) { await removeWindowRecord(helpers.record).catch(() => undefined); helpers.record = next; }
    }).catch(error => this.output.appendLine(`[lanes] discovery record not updated: ${this.describe(error)}`));
  }
  // ---- Connecting Claude Code and Codex to Hydra (plan, Phase 5) ----
  private helperServerSpec(provider: ConnectableProvider): HelperServerSpec { const bridge = this.helperBridge(provider); return { command: bridge.command, args: bridge.args, env: bridge.env }; }
  /** Claude's own CLI does the registration: the configured or PATH claude, else the extension's bundled one. */
  async helperConnections(): Promise<ProviderConnectionView[]> {
    const paths = providerPaths();
    const [claude, codex, memory] = await Promise.all([claudeStatus(paths, this.helperServerSpec('claude')), codexStatus(paths.codexConfig, this.helperServerSpec('codex')), claudeMemStatus()]);
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
    const claude = await claudeForRegistration();
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
    const paths = providerPaths(), spec = this.helperServerSpec(provider);
    if (provider === 'codex') await connectCodex(paths.codexConfig, spec);
    else if (provider === 'claude') {
      const claude = await claudeForRegistration();
      if (!claude) throw new Error('Install the Claude Code extension or CLI first; Hydra connects through it.');
      await connectClaude(claude, paths, spec, await this.limitHookFor(claude));
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
    else if (provider === 'claude') await disconnectClaude(await claudeForRegistration(), paths);
    else throw new Error('Unknown provider.');
    this.output.appendLine(`[heads] disconnected ${provider} from Hydra`);
  }
  /** A connection made by an older Hydra (a different executable path) is refreshed; nothing is connected here that the user didn't connect. */
  private async refreshHelperConnections(): Promise<void> {
    // A development or test window (another profile, another extension folder) would
    // point the user's real Claude and Codex at itself; only an installed Hydra refreshes.
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) { this.output.appendLine('[heads] development window: leaving the Claude and Codex connections as they are'); return; }
    for (const connection of await this.helperConnections()) {
      if (connection.connected && !connection.current && !connection.error) {
        await this.connectHelpers(connection.provider).catch(error => this.output.appendLine(`[heads] could not refresh ${connection.provider}: ${this.describe(error)}`));
      } else if (connection.provider === 'claude' && connection.connected && !connection.error) {
        await this.refreshLimitHook().catch(error => this.output.appendLine(`[limits] could not refresh the Claude hook: ${this.describe(error)}`));
      }
    }
  }
  /**
   * A connected Claude gets the usage-limit hook: rewritten when Hydra's path moved,
   * added when a Connect from before the hook existed didn't write it.
   */
  private async refreshLimitHook(): Promise<void> {
    const paths = providerPaths(), group = this.limitHook();
    const state = limitHookState(await read(paths.claudeSettings), group);
    if (state === 'current') return;
    if (state === 'missing') { const claude = await claudeForRegistration(); if (!claude || !await this.limitHookFor(claude)) return; }
    await setClaudeLimitHook(paths, group);
    this.output.appendLine(`[limits] ${state === 'stale' ? 'updated' : 'added'} the Claude usage-limit hook`);
  }
  /** Dashboard actions: review a helper's changes as a diff, open its log, or cancel it. */
  private async helperAction(action: 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer', jobId: string): Promise<void> {
    const helpers = this.helpers;
    const job = helpers?.store.get(jobId);
    if (!helpers || !job) throw new Error('That head is not in this window.');
    if (action === 'helperCancel') { await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_cancel_head', { job_id: jobId, reason: 'Cancelled from the Agents view.' }, new AbortController().signal); return; }
    if (action === 'helperAnswer') {
      // The head is waiting on the lead; you can answer in its place from the Agents view.
      if (job.state !== 'blocked') throw new Error('That head is not waiting for an answer.');
      const message = await vscode.window.showInputBox({ title: `Answer "${job.title}"`, prompt: job.question || 'The head is waiting for an answer.', placeHolder: 'Your answer', ignoreFocusOut: true, validateInput: value => value.trim() && value.length <= 8000 ? undefined : 'Write an answer (up to 8000 characters).' });
      if (message === undefined) return;
      await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_reply_to_head', { job_id: jobId, message }, new AbortController().signal);
      return;
    }
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
    const plans = this.plans; this.plans = undefined;
    for (const controller of plans?.planning.values() ?? []) controller.abort();
    const helpers = this.helpers; this.helpers = undefined;
    await this.lanes.stop().catch(() => undefined);
    if (!helpers) return;
    await this.discovery?.queue.catch(() => undefined); this.discovery = undefined;
    await removeWindowRecord(helpers.record).catch(() => undefined);
    await helpers.service.dispose();
    await helpers.endpoint.close();
  }
  async showFirstRun(): Promise<void> {
    await this.collapseSidebarOnce();
    const onboarding = this.disabled ? false : await this.onboarding.autoShow(!!vscode.workspace.getConfiguration('hydra').get('handoff'));
    // Onboarding has its own path into the Agents view (the Providers step); a
    // handoff window is already forced to Agents in initialize(). Neither is
    // overridden by the startup layout setting.
    if (!onboarding && !this.handoff && this.mode === 'editor' && vscode.workspace.getConfiguration('hydra').get<string>('startupLayout') === 'agents') {
      await this.openAgents();
    }
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
  private async verifyHandoffWorkspace(): Promise<void> {
    if (!this.handoff) throw new Error('Open the handoff workspace to use this action.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || path.relative(await realpath(folders[0]!.uri.fsPath), await realpath(this.handoff.task.worktree)) !== '') throw new Error('Handoff workspace does not match the exact handoff worktree.');
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
  private async refresh(): Promise<void> { this.error = undefined; await this.refreshRepositories(); await this.publish(); }
  private describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private report(error: unknown): void {
    this.error = this.describe(error);
    this.output.appendLine(this.error);
    void vscode.window.showErrorMessage(`Hydra: ${this.error}`);
    void this.publish();
  }
  private async verifyWorktree(task: Pick<HandoffTask, 'repository' | 'worktree' | 'branch'>): Promise<void> {
    const actual = await realpath(task.worktree);
    if (actual !== await repositoryRoot(actual)) throw new Error('Saved worktree is not a repository root.');
    const [taskCommon, mainCommon, branch] = await Promise.all([
      git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(task.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(actual, ['symbolic-ref', '--short', 'HEAD'])
    ]);
    if (await realpath(taskCommon.trim()) !== await realpath(mainCommon.trim())) throw new Error('Handoff worktree belongs to a different repository.');
    if (branch.trim() !== task.branch) throw new Error('Handoff worktree branch changed. Restore its recorded branch.');
  }
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  /** One trailing publish for high-frequency updates; an immediate publish() supersedes it. */
  /** The heads the webview shows (Agents canvas and dashboard), newest first. */
  private headViews(): HelperJobView[] | undefined {
    const service = this.helpers?.service;
    return service?.list().map(job => ({
      id: job.id, title: job.title, state: job.state, provider: job.provider, createdAt: job.createdAt, finishedAt: job.finishedAt,
      progress: job.progress, question: job.state === 'blocked' ? job.question : undefined, reason: job.state === 'running' ? undefined : job.reason,
      branch: job.branch, commit: job.result?.commit, summary: job.result?.summary, changedFiles: job.result?.changedFiles.length ?? 0,
      checks: job.result?.checks.map(check => ({ id: check.id, passed: check.passed })) ?? [],
      repository: service.leadFolder, worktree: job.worktree, dependsOn: job.dependsOn,
      lead: job.lead, merged: service.isMerged(job.id), startedAt: job.startedAt, writeScope: job.writeScope,
    })).reverse();
  }
  /** Head changes go to the webview at once (the Agents canvas animates them); the full snapshot follows, debounced. */
  private headsChanged(): void {
    const heads = this.headViews() ?? [];
    void this.broadcast({ type: 'heads', heads }).catch(() => undefined);
    this.tree.update({ heads });
    this.publishSoon();
  }
  private publishSoon(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; void this.publish().catch(error => this.report(error)); }, 200);
  }
  private async publish(): Promise<void> {
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    const generation = ++this.snapshotGeneration;
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agents' : 'Editor'}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = 'Hydra: Switch Editor / Agents (Ctrl+Alt+A)';
    if (generation !== this.snapshotGeneration) return;
    const snapshot: Snapshot = {
      mode: this.mode, busy: this.busy || this.disabled, error: this.error,
      helpers: this.headViews(), plans: this.plans?.store.list(), defaultProvider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude'),
      handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')),
    };
    await this.broadcast({ type: 'snapshot', snapshot });
  }
  // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----
  /** Plan changes go to the webview at once (mirrors headsChanged); the full snapshot follows, debounced. */
  private plansChanged(): void {
    const plans = this.plans?.store.list() ?? [];
    void this.broadcast({ type: 'plans', plans }).catch(() => undefined);
    this.tree.update({ plans });
    this.publishSoon();
  }
  private requirePlans(): { store: PlanStore; planning: Map<string, AbortController> } {
    if (!this.plans) throw new Error('Hydra plans are not ready in this window yet.');
    return this.plans;
  }
  private async newPlan(): Promise<void> {
    const loaded = !!this.panel;
    this.pendingNewPlan = !loaded;
    await this.openAgents();
    if (loaded) await this.broadcast({ type: 'showNewPlan' });
  }
  private async planCreateEmpty(title: string): Promise<void> {
    const plans = this.requirePlans();
    await plans.store.save(createPlan({ title, state: 'draft' }));
    this.plansChanged();
  }
  private async planCreate(title: string, brief: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = await plans.store.save(createPlan({ title, brief, state: 'planning' }));
    this.plansChanged();
    void this.draftPlan(plan.id, brief);
  }
  private async planRetry(id: string): Promise<void> {
    const plans = this.requirePlans();
    const current = plans.store.get(id);
    if (!current) throw new Error(`No plan ${id}.`);
    if (current.state !== 'failed') throw new Error('Only a failed plan can be retried.');
    if (!current.brief) throw new Error('This plan has no brief to retry; use "+ Job" instead.');
    await plans.store.save({ ...current, state: 'planning', error: undefined });
    this.plansChanged();
    void this.draftPlan(id, current.brief);
  }
  private planCancel(id: string): void {
    this.plans?.planning.get(id)?.abort();
  }
  /** The failed state's "Start empty": keep the plan, but clear the failed brief attempt to an empty draft. */
  private async planStartEmpty(id: string): Promise<void> {
    const plans = this.requirePlans();
    const current = plans.store.get(id);
    if (!current) throw new Error(`No plan ${id}.`);
    plans.planning.get(id)?.abort();
    plans.planning.delete(id);
    await plans.store.save({ ...current, state: 'draft', jobs: [], error: undefined });
    this.plansChanged();
  }
  /** Run the planner CLI and record the result. Runs in the background (called with `void`); `plansChanged` tells the webview when it settles. */
  private async draftPlan(id: string, brief: string): Promise<void> {
    const plans = this.plans;
    if (!plans) return; // the window closed between starting this and getting here
    const controller = new AbortController();
    plans.planning.set(id, controller);
    try {
      const helpers = this.helpers;
      if (!helpers) throw new Error('Hydra heads are not ready in this window yet.');
      const provider: Provider = vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude');
      const executable = await this.helperExecutable(provider);
      const result = await planBrief({ provider, executable, repository: helpers.service.leadFolder, brief, signal: controller.signal });
      const current = plans.store.get(id);
      if (!current || current.state !== 'planning') return; // deleted, or cancelled and already marked failed
      await plans.store.save(result.ok ? { ...current, jobs: result.jobs, state: 'draft', error: undefined } : { ...current, state: 'failed', error: result.error });
    } catch (error) {
      const current = plans.store.get(id);
      if (current?.state === 'planning') await plans.store.save({ ...current, state: 'failed', error: this.describe(error) }).catch(() => undefined);
    } finally {
      plans.planning.delete(id);
      this.plansChanged();
    }
  }
  private async planDelete(id: string): Promise<void> {
    const plans = this.requirePlans();
    plans.planning.get(id)?.abort();
    plans.planning.delete(id);
    await plans.store.remove(id);
    this.plansChanged();
  }
  private async planAddJob(id: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    if (!plan) throw new Error(`No plan ${id}.`);
    if (plan.jobs.length >= maxPlanJobs) throw new Error(`A plan may have at most ${maxPlanJobs} jobs.`);
    let index = plan.jobs.length + 1, key = `job-${index}`;
    while (plan.jobs.some(job => job.key === key)) key = `job-${++index}`;
    const job: PlanJob = { key, title: 'New job', brief: 'Describe what this job should do.', dependsOn: [] };
    await plans.store.save({ ...plan, jobs: [...plan.jobs, job] });
    this.plansChanged();
  }
  private async planSaveJob(id: string, key: string, title: string, brief: string, provider?: Provider): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    if (!plan?.jobs.some(job => job.key === key)) throw new Error(`No job "${key}" in this plan.`);
    await plans.store.save({ ...plan, jobs: plan.jobs.map(job => job.key === key ? { ...job, title, brief, provider } : job) });
    this.plansChanged();
  }
  private async planDeleteJob(id: string, key: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    if (!plan) throw new Error(`No plan ${id}.`);
    const jobs = plan.jobs.filter(job => job.key !== key).map(job => ({ ...job, dependsOn: job.dependsOn.filter(dependency => dependency !== key) }));
    await plans.store.save({ ...plan, jobs });
    this.plansChanged();
  }
  /** "Depends on…": a native multi-select quick pick of the plan's other jobs. */
  private async planDependsOn(id: string, key: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    const job = plan?.jobs.find(item => item.key === key);
    if (!plan || !job) throw new Error(`No job "${key}" in this plan.`);
    const others = plan.jobs.filter(item => item.key !== key);
    const picked = await vscode.window.showQuickPick(
      others.map(item => ({ label: item.title, description: item.key, picked: job.dependsOn.includes(item.key) })),
      { canPickMany: true, title: `"${job.title}" depends on…`, placeHolder: 'Select the jobs that must finish first' },
    );
    if (picked === undefined) return; // Esc: leave it as it was
    const dependsOn = picked.map(item => item.description!);
    await plans.store.save({ ...plan, jobs: plan.jobs.map(item => item.key === key ? { ...item, dependsOn } : item) });
    this.plansChanged();
  }
  private async planAddDependency(id: string, key: string, dependsOn: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    if (!plan?.jobs.some(job => job.key === key) || !plan.jobs.some(job => job.key === dependsOn)) throw new Error('Unknown job.');
    await plans.store.save({ ...plan, jobs: plan.jobs.map(job => job.key === key && !job.dependsOn.includes(dependsOn) ? { ...job, dependsOn: [...job.dependsOn, dependsOn] } : job) });
    this.plansChanged();
  }
  private async planRemoveDependency(id: string, key: string, dependsOn: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    if (!plan) throw new Error(`No plan ${id}.`);
    await plans.store.save({ ...plan, jobs: plan.jobs.map(job => job.key === key ? { ...job, dependsOn: job.dependsOn.filter(dependency => dependency !== dependsOn) } : job) });
    this.plansChanged();
  }
  /** Run plan: start every not-yet-started job in dependency order, under lead `plan-<id>` so the heads group under the plan node (jobs.jobId makes this idempotent). */
  private async runPlanById(id: string): Promise<void> {
    const plans = this.requirePlans(), helpers = this.helpers;
    if (!helpers) throw new Error('Hydra heads are not ready in this window yet.');
    const plan = plans.store.get(id);
    if (!plan) throw new Error(`No plan ${id}.`);
    if (plan.state === 'planning') throw new Error('This plan is still being drafted.');
    if (plan.state === 'done') throw new Error('This plan is already done.');
    const defaultProvider: Provider = vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude');
    const updated = await runPlan(plan, async (job, dependsOn) => {
      const result = await helpers.service.handle(
        { role: 'lead', leadKey: this.leadKey, leadSessionId: `plan-${plan.id}` }, 'hydra_start_head',
        {
          title: job.title, brief: job.brief, write_scope: job.writeScope?.length ? job.writeScope : [''],
          provider: job.provider ?? defaultProvider, idempotency_key: `plan-${plan.id}-${job.key}`,
          depends_on: dependsOn, lead_label: `Plan · ${plan.title}`,
        },
        new AbortController().signal,
      ) as { job_id: string };
      return { jobId: result.job_id };
    });
    await plans.store.save(updated);
    this.plansChanged();
  }
  private async broadcast(message: unknown): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }
  private connectWebview(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(value => { void this.handle(value).catch(error => this.report(error)); }, undefined, this.context.subscriptions);
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
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'hydra-logo.png'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Hydra</title></head><body data-logo="${logo}"><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  private async handle(value: unknown): Promise<void> {
    const message = parseMessage(value);
    if (message.type === 'ready') {
      await this.publish();
      this.readyPanel = this.panel; this.lanes.webviewReady();
      if (this.pendingNewPlan) { this.pendingNewPlan = false; await this.broadcast({ type: 'showNewPlan' }); }
      return;
    }
    if (isLaneMessage(message)) { await this.lanes.handle(message); return; }
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'agents') { await this.openAgents(); return; }
    if (message.type === 'settings') { this.settings.show(); return; }
    if (message.type === 'refresh') { await this.refresh(); return; }
    if (message.type === 'helperStopAll') { await vscode.commands.executeCommand('hydra.stopAllHelpers'); return; }
    if (message.type === 'helperReview' || message.type === 'helperLog' || message.type === 'helperCancel' || message.type === 'helperAnswer') { await this.helperAction(message.type, message.jobId); return; }
    // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----
    if (message.type === 'planCreate') { await this.planCreate(message.title, message.brief); return; }
    if (message.type === 'planCreateEmpty') { await this.planCreateEmpty(message.title); return; }
    if (message.type === 'planRetry') { await this.planRetry(message.id); return; }
    if (message.type === 'planCancel') { this.planCancel(message.id); return; }
    if (message.type === 'planDelete') { await this.planDelete(message.id); return; }
    if (message.type === 'planStartEmpty') { await this.planStartEmpty(message.id); return; }
    if (message.type === 'planAddJob') { await this.planAddJob(message.id); return; }
    if (message.type === 'planSaveJob') { await this.planSaveJob(message.id, message.key, message.title, message.brief, message.provider); return; }
    if (message.type === 'planDeleteJob') { await this.planDeleteJob(message.id, message.key); return; }
    if (message.type === 'planDependsOn') { await this.planDependsOn(message.id, message.key); return; }
    if (message.type === 'planAddDependency') { await this.planAddDependency(message.id, message.key, message.dependsOn); return; }
    if (message.type === 'planRemoveDependency') { await this.planRemoveDependency(message.id, message.key, message.dependsOn); return; }
    if (message.type === 'planRun') { await this.runPlanById(message.id); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use Hydra.');
    if (this.disabled) throw new Error('Hydra is disabled in this window. Resolve the ownership or handoff error and reload this window.');
    if (message.type === 'checkProvider') {
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
    // openOfficial, showOfficial and copyHandoffPrompt act only in a handoff window.
    await this.verifyHandoffWorkspace();
    const handoff = this.handoff!;
    if (message.type === 'openOfficial') await openOfficialExtension(handoff.task.provider);
    else if (message.type === 'showOfficial') await vscode.commands.executeCommand('workbench.extensions.search', `@id:${officialProviders[handoff.task.provider].extensionId}`);
    else await vscode.env.clipboard.writeText(handoff.task.prompt);
    await this.publish();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.stopHelpers().catch(error => this.report(error));
    await this.accounts.shutdown();
    await this.quota.shutdown();
    for (const controller of this.diagnosticChecks) controller.abort();
    for (const lock of this.locks) await lock.release();
  }
}
