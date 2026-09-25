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
import { JobStore, resolveHeadDefaults } from './core/jobs';
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
import { parseMessage, type HelperJobView, type Provider, type ProviderDiagnostic, type Snapshot, type Handoff, type HandoffTask } from './core/model';

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
  constructor(private readonly context: vscode.ExtensionContext) {
    this.settingsImport = new SettingsImport(context);
    this.accounts = new ProviderAccounts(context, this.settingsImport.available);
    this.quota = new ProviderQuota(context, this.settingsImport.available);
    this.settings = new AppearanceSettings(context, this.settingsImport);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings);
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota, this.limitEvents);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
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
      onChange: () => this.headsChanged(), log: line => this.output.appendLine(line),
    });
    this.context.subscriptions.push(service.onLimit(event => this.limitEvents.fire(event)));
    await service.recover();
    const record = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port, pid: process.pid, folders });
    this.helpers = { store, endpoint, service, record };
    this.output.appendLine(`[heads] ready for ${leadFolder}`);
    void this.refreshHelperConnections();
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
    const helpers = this.helpers; this.helpers = undefined;
    if (!helpers) return;
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
    void this.broadcast({ type: 'heads', heads: this.headViews() ?? [] }).catch(() => undefined);
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
      helpers: this.headViews(),
      handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')),
    };
    await this.broadcast({ type: 'snapshot', snapshot });
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
    if (message.type === 'ready') { await this.publish(); return; }
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'agents') { await this.openAgents(); return; }
    if (message.type === 'settings') { this.settings.show(); return; }
    if (message.type === 'refresh') { await this.refresh(); return; }
    if (message.type === 'helperStopAll') { await vscode.commands.executeCommand('hydra.stopAllHelpers'); return; }
    if (message.type === 'helperReview' || message.type === 'helperLog' || message.type === 'helperCancel' || message.type === 'helperAnswer') { await this.helperAction(message.type, message.jobId); return; }
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
