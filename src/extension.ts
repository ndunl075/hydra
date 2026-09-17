import * as vscode from 'vscode';
import { randomBytes, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from './core/store';
import { OwnershipLock } from './core/ownership';
import { changedFiles, createWorktree, git, repositoryRoot, resolveTaskFile } from './core/worktrees';
import { findProvider, terminalLaunch } from './core/providers';
import { parseMessage, type Task, type Snapshot, type ProviderInfo, type Draft } from './core/model';

let manager: Manager | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  manager = new Manager(context);
  await manager.initialize();
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
  constructor(private readonly context: vscode.ExtensionContext) {
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.store = new LocalStore(this.storageDirectory);
  }
  async initialize(): Promise<void> {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, (...args) =>
      Promise.resolve().then(() => callback(...args)).catch(error => { this.report(error); throw error; })));
    command('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    command('hydra.openAgents', () => this.openAgents());
    command('hydra.newTask', async () => { this.pendingNewTask = !this.panel; await this.openAgents(); await this.panel?.webview.postMessage({ type: 'newTask' }); });
    command('hydra.openTask', async (id: string) => { this.getTask(id); this.selectedId = id; await this.openAgents(); });
    command('hydra.refresh', () => this.refresh());
    command('hydra.createTask', async (input?: unknown) => {
      if (input === undefined) { this.pendingNewTask = !this.panel; await this.openAgents(); await this.panel?.webview.postMessage({ type: 'newTask' }); return; }
      if (!input || typeof input !== 'object') throw new Error('Expected task options.');
      await this.handle({ ...input, type: 'create' });
      return structuredClone(this.getTask(this.selectedId!));
    });
    command('hydra.launchTask', (id: string) => this.handle({ type: 'launch', id }));
    command('hydra.stopTask', (id: string) => this.handle({ type: 'stop', id }));
    command('hydra.listTasks', () => structuredClone(this.tasks));
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
      if (event.affectsConfiguration('hydra')) void this.refresh().catch(error => this.report(error));
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
          if (task.state === 'external') task.state = 'interrupted';
          try { await this.verifyWorktree(task); }
          catch (error) { task.state = 'error'; task.error = this.describe(error); }
        }
        await this.store.save(this.tasks);
      }
      this.selectedId = this.tasks[0]?.id;
      this.draft = { title: '', prompt: '', provider: vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude') };
      await this.refreshProviders();
    } catch (error) { this.disabled = true; this.report(error); }
    await this.publish();
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
  private async refresh(): Promise<void> { await this.refreshProviders(); await this.publish(); }
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
  private async verifyWorktree(task: Task): Promise<void> {
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
  private async publish(): Promise<void> {
    const generation = ++this.snapshotGeneration;
    this.tree.changed.fire(undefined);
    const active = this.terminals.size;
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agents' : 'Editor'}${active ? ` · ${active} active` : ''}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = 'Hydra: Switch Editor / Agents (Ctrl+Alt+A)';
    const task = this.tasks.find(item => item.id === this.selectedId);
    let files: Snapshot['files'] = [];
    let error = this.error;
    if (task && vscode.workspace.isTrusted) {
      try { await this.verifyWorktree(task); files = await changedFiles(task.worktree, task.baseCommit); }
      catch (failure) { error = this.describe(failure); }
    }
    if (generation !== this.snapshotGeneration) return;
    const snapshot: Snapshot = {
      tasks: this.tasks, selectedId: this.selectedId, mode: this.mode, repositories: this.repositories,
      providers: this.providers, files, busy: this.busy || this.disabled, error, draft: this.draft
    };
    await this.panel?.webview.postMessage({ type: 'snapshot', snapshot });
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
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'hydra.svg');
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
    if (message.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'hydra'); return; }
    if (message.type === 'refresh') { this.error = undefined; await this.refresh(); return; }
    if (message.type === 'draft') { this.draft = { title: message.title, prompt: message.prompt, provider: message.provider }; return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use task worktrees and terminals.');
    if (this.disabled) throw new Error('Hydra task operations are disabled. Resolve the storage or ownership error and reload this window.');
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
      const terminal = this.terminals.get(task.id);
      if (!terminal) return;
      terminal.dispose();
      return;
    }
    await this.verifyWorktree(task);
    if (message.type === 'openWorktree') {
      if (this.terminals.has(task.id)) throw new Error('Stop this task terminal before handing off to another window.');
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktree), { forceNewWindow: true });
      return;
    }
    if (message.type === 'openFile') {
      const file = await resolveTaskFile(task.worktree, message.path);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: false });
      return;
    }
    if (message.type === 'terminal' || message.type === 'launch') {
      const existing = this.terminals.get(task.id);
      if (existing) { existing.show(false); return; }
      const max = vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentTasks', 2);
      if (this.terminals.size >= max) throw new Error(`The ${max}-terminal concurrency limit is reached. Stop a task terminal before launching another.`);
      await this.refreshProviders();
      const provider = this.providers.find(item => item.provider === task.provider);
      if (!provider?.executable) throw new Error(`${task.provider} CLI not found. Install it or set Hydra's ${task.provider} path. Authentication remains with the official CLI.`);
      // Recheck after async probes to prevent simultaneous webview launches exceeding the limit.
      const duplicate = this.terminals.get(task.id);
      if (duplicate) { duplicate.show(false); return; }
      if (this.terminals.size >= max) throw new Error('The terminal concurrency limit is reached.');
      const terminal = vscode.window.createTerminal({ name: `Hydra · ${task.title}`, cwd: task.worktree, ...terminalLaunch(provider.executable), isTransient: true });
      this.terminals.set(task.id, terminal);
      task.state = 'external';
      task.error = undefined;
      task.updatedAt = new Date().toISOString();
      terminal.show(false);
      await this.persist();
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const [id, terminal] of this.terminals) {
      terminal.dispose();
      const task = this.getTask(id);
      task.state = 'interrupted';
      task.updatedAt = new Date().toISOString();
    }
    try { if (!this.disabled) await this.store.save(this.tasks); }
    finally { for (const lock of this.locks) await lock.release(); }
  }
}
