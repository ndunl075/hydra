import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { CodexMessages, CodexTurn, providerId, record, testedCodexVersion, validateCodexThread, type RpcId } from './codexProtocol';
import { processLaunch, terminateProcessTree } from './process';
import { SessionStore } from './sessionStore';
import { version as hydraVersion } from '../../package.json';
import type { Approval, SessionView, Task, Turn } from './model';
import type { InitializeParams } from './generated/codex-0.154.0/InitializeParams';
import type { ThreadStartParams } from './generated/codex-0.154.0/v2/ThreadStartParams';
import type { ThreadResumeParams } from './generated/codex-0.154.0/v2/ThreadResumeParams';
import type { TurnStartParams } from './generated/codex-0.154.0/v2/TurnStartParams';
import type { TurnInterruptParams } from './generated/codex-0.154.0/v2/TurnInterruptParams';
import { parseEffectiveModel, readModelCatalog, requireAdvertisedSelection, verifyEffectiveModel } from './modelSelection';

export class ManagedCodex {
  private readonly views = new Map<string, SessionView>();
  private readonly active = new Map<string, { stop: () => Promise<void>; done: Promise<void>; approve: (id: string, decision: 'accept' | 'decline') => void }>();
  private readonly starting = new Set<string>();
  constructor(readonly store: SessionStore, private readonly persistTask: () => Promise<void>, private readonly changed: () => void, private readonly report: (error: unknown) => void) {}
  get count(): number { return this.active.size; }
  has(id: string): boolean { return this.active.has(id); }
  view(id: string): SessionView | undefined { const view = this.views.get(id); return view ? { ...view, active: this.has(id) || this.starting.has(id) } : undefined; }
  async load(task: Task): Promise<void> { const view = await this.store.load(task.id); delete view.approvals; this.views.set(task.id, view); }
  async start(task: Task, executable: string, prompt: string, beforeTurn: () => void = () => {}, environment: Record<string, string> = {}): Promise<void> {
    if (this.starting.has(task.id) || this.has(task.id)) throw new Error('Stop the existing task writer before starting a managed turn.');
    this.starting.add(task.id);
    try { await this.startTurn(task, executable, prompt, beforeTurn, environment); } finally { this.starting.delete(task.id); }
  }
  private async startTurn(task: Task, executable: string, prompt: string, beforeTurn: () => void, environment: Record<string, string>): Promise<void> {
    const expectedSchedule = task.schedule;
    if (task.provider !== 'codex' || task.providerVersion !== testedCodexVersion) throw new Error('Managed Codex requires CLI 0.154.0.');
    if (task.sessionId && task.sessionProvider !== 'codex') throw new Error('This recorded session belongs to another provider. Create a separate Codex task.');
    if (task.interface === 'official-extension' || task.state === 'external') throw new Error('Stop the existing task writer first.');
    if (!this.views.has(task.id)) await this.load(task);
    const view = this.views.get(task.id)!;
    const selection = task.modelSelection ? { ...task.modelSelection } : undefined;
    const turn: Turn = { id: randomBytes(6).toString('hex'), provider: 'codex', prompt, text: '', status: 'running', createdAt: new Date().toISOString(), ...(selection ? { modelSettings: { requested: selection } } : {}) };
    view.turns.push(turn); view.approvals = [];
    task.interface = 'managed-cli'; task.state = 'running'; task.error = undefined; task.updatedAt = new Date().toISOString();
    let sequence = 0;
    try {
      await this.store.save(task.id, view);
      await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'start', cwd: task.worktree, version: testedCodexVersion, prompt });
      await this.persistTask();
      if (expectedSchedule && (task.schedule !== expectedSchedule || expectedSchedule.state === 'cancelled')) {
        turn.status = 'interrupted'; turn.error = 'Cancelled before provider process started.';
        task.state = 'interrupted'; task.error = undefined;
        await this.store.save(task.id, view); await this.persistTask(); this.changed(); return;
      }
    } catch (error) { turn.status = 'error'; turn.error = `Session setup failed: ${String(error)}`; task.state = 'error'; task.error = turn.error; throw error; }
    const launch = processLaunch(executable, ['app-server', '--listen', 'stdio://']);
    const child = spawn(launch.executable, launch.args, { cwd: task.worktree, env: { ...process.env, ...environment }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const approvals = new Map<string, { rpcId: RpcId; approval: Approval }>();
    const reviewItems = new Map<string, Record<string, any>>();
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    let nextId = 0, bytes = 0, failure: string | undefined, stopped = false, closing = false, protocol: CodexTurn | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const alive = () => child.pid && child.exitCode === null && child.signalCode === null;
    const kill = async () => { if (alive()) await terminateProcessTree(child.pid!); };
    const fail = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error.message : String(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(failure)); }
      pending.clear(); void kill().catch(this.report);
    };
    const log = (type: string, data: unknown) => { void this.store.log(task.id, turn.id, { sequence: ++sequence, type, data }).catch(fail); };
    const send = (message: unknown) => { if (closing || failure || !alive()) throw new Error('Codex connection is closed.'); log('stdin', message); child.stdin.write(JSON.stringify(message) + '\n'); };
    const request = (method: string, params: unknown, timeout = 15000): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    const update = () => {
      if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = undefined; void this.store.save(task.id, view).catch(fail); this.changed(); }, 250);
    };
    const finish = () => {
      if (closing) return;
      closing = true; approvals.clear(); view.approvals = []; child.stdin.end();
      closeTimer = setTimeout(() => { void kill().catch(this.report); }, 3000);
    };
    const interrupt = async () => {
      stopped = true; approvals.clear(); view.approvals = []; this.changed();
      if (protocol?.id && !protocol.completed && !closing && !failure) {
        try { await request('turn/interrupt', { threadId: protocol.threadId, turnId: protocol.id } satisfies TurnInterruptParams, 3000); } catch { await kill(); }
        await Promise.race([done, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
      }
      if (!protocol?.completed) await kill();
      await done;
    };
    const approve = (id: string, decision: 'accept' | 'decline') => {
      const entry = approvals.get(id);
      if (!entry || stopped || closing || !protocol?.id || protocol.completed) throw new Error('This approval is no longer pending.');
      send({ id: entry.rpcId, result: { decision } });
      approvals.delete(id); view.approvals = [...approvals.values()].map(value => value.approval); update();
    };
    this.active.set(task.id, { stop: interrupt, done, approve });
    const messages = new CodexMessages(message => {
      if (typeof message.method !== 'string') {
        if (typeof message.id !== 'number' || !pending.has(message.id)) throw new Error('Unmatched Codex RPC response.');
        const entry = pending.get(message.id)!; clearTimeout(entry.timer); pending.delete(message.id);
        if ('error' in message) entry.reject(new Error(`Codex: ${record(message.error).message}`));
        else if ('result' in message) entry.resolve(message.result);
        else entry.reject(new Error('Invalid Codex RPC response.'));
        return;
      }
      if ('id' in message) {
        if (typeof message.id !== 'string' && (typeof message.id !== 'number' || !Number.isSafeInteger(message.id))) throw new Error('Invalid Codex server request ID.');
        const params = record(message.params);
        if (stopped || !protocol?.id || protocol.completed || params.threadId !== protocol.threadId || params.turnId !== protocol.id) throw new Error('Unmatched Codex approval request.');
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          send({ id: message.id, error: { code: -32601, message: 'Hydra does not support this server request. Use the official client.' } });
          throw new Error(`Unsupported Codex request: ${message.method}. Raw details retained; use the provider terminal.`);
        }
        if ([...approvals.values()].some(entry => entry.rpcId === message.id)) throw new Error('Duplicate Codex approval request.');
        const id = randomBytes(6).toString('hex');
        const item = typeof params.itemId === 'string' ? reviewItems.get(params.itemId) : undefined;
        if (message.method === 'item/fileChange/requestApproval' && (!item || item.type !== 'fileChange' || !Array.isArray(item.changes))) throw new Error('Codex file approval has no matching proposed changes. No permission granted; use the provider terminal.');
        const detail = JSON.stringify({ request: params, ...(item ? { item } : {}) }, null, 2);
        if (detail.length > 50000) throw new Error('Codex approval details exceed the display limit. No permission granted; use the provider terminal.');
        const approval: Approval = { id, kind: message.method.includes('fileChange') ? 'file' : params.networkApprovalContext ? 'network' : 'command', detail };
        approvals.set(id, { rpcId: message.id, approval }); view.approvals = [...approvals.values()].map(value => value.approval); update();
        return;
      }
      if (message.method === 'item/started') {
        const params = record(message.params);
        if (protocol?.id && params.threadId === protocol.threadId && params.turnId === protocol.id) {
          const item = record(params.item);
          if (typeof item.id === 'string' && ['fileChange', 'commandExecution'].includes(item.type)) reviewItems.set(item.id, item);
        }
      }
      if (message.method === 'serverRequest/resolved') {
        const params = record(message.params);
        if (protocol && params.threadId === protocol.threadId) {
          for (const [id, entry] of approvals) if (entry.rpcId === params.requestId) approvals.delete(id);
          view.approvals = [...approvals.values()].map(value => value.approval); update();
        }
      } else if (protocol && protocol.notification(message.method, message.params)) {
        update(); if (protocol.completed) finish();
      }
    });
    child.stdout.on('data', (data: Buffer) => {
      log('stdout', stdout.write(data)); bytes += data.length;
      if (bytes > 32 * 1024 * 1024) { fail(new Error('Codex output exceeded 32 MiB. Process stopped; evidence retained.')); return; }
      if (!failure) try { messages.push(data); } catch (error) { fail(error); }
    });
    child.stderr.on('data', (data: Buffer) => { log('stderr', stderr.write(data)); bytes += data.length; if (bytes > 32 * 1024 * 1024) fail(new Error('Codex output exceeded 32 MiB.')); });
    child.stdin.on('error', fail); child.on('error', fail);
    child.on('close', code => {
      void (async () => {
        clearTimeout(saveTimer); clearTimeout(closeTimer);
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex process exited.')); } pending.clear();
        log('stdout', stdout.end()); log('stderr', stderr.end());
        if (!failure) try { messages.end(); } catch (error) { failure = String(error); }
        view.approvals = []; approvals.clear();
        if (stopped) { turn.status = 'interrupted'; turn.error = 'Codex turn interrupted. Check the worktree before resuming.'; }
        else if (failure || !protocol?.completed || code !== 0) { turn.status = 'error'; turn.error = failure || `Codex exited ${code} without a clean completed turn.`; }
        task.state = turn.status === 'completed' ? 'idle' : turn.status === 'running' ? 'error' : turn.status;
        task.error = turn.error; task.updatedAt = new Date().toISOString();
        try {
          await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'exit', code, status: turn.status, error: turn.error });
          await this.store.save(task.id, view);
        } catch (error) { turn.status = 'error'; task.state = 'error'; task.error = `Session storage failed: ${String(error)}`; this.report(error); }
        try { await this.persistTask(); } catch (error) { this.report(error); }
        finally { this.active.delete(task.id); this.changed(); resolveDone(); }
      })().catch(error => { this.report(error); this.active.delete(task.id); resolveDone(); });
    });
    // Run the handshake after handlers/ownership are established. No turn is sent until its thread identity is durably saved.
    void (async () => {
      const init = record(await request('initialize', { clientInfo: { name: 'hydra', title: 'Hydra', version: hydraVersion }, capabilities: { experimentalApi: false, requestAttestation: false } } satisfies InitializeParams));
      if (typeof init.userAgent !== 'string' || !init.userAgent.includes(testedCodexVersion)) throw new Error('Codex initialization did not identify the tested version.');
      if (stopped) { await kill(); return; }
      send({ method: 'initialized', params: {} });
      if (process.platform === 'win32') {
        const readiness = record(await request('windowsSandbox/readiness', undefined));
        if (readiness.status !== 'ready') throw new Error(`Codex Windows sandbox ${readiness.status === 'updateRequired' ? 'needs updating' : 'is not configured'}. Complete sandbox setup in the official Codex client, then retry. Hydra does not change Windows security settings.`);
      }
      if (selection) requireAdvertisedSelection(await readModelCatalog(request), selection);
      if (stopped) { await kill(); return; }
      beforeTurn();
      const options = { cwd: task.worktree, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(selection ? { model: selection.model, config: { model_reasoning_effort: selection.effort } } : {}) } satisfies ThreadStartParams;
      const response = task.sessionId ? await request('thread/resume', { ...options, threadId: providerId(task.sessionId) } satisfies ThreadResumeParams) : await request('thread/start', options);
      const threadId = validateCodexThread(response, task.worktree, task.sessionId);
      task.sessionId = threadId; task.sessionProvider = 'codex'; await this.persistTask();
      if (selection || record(response).model !== undefined) {
        turn.modelSettings = { ...turn.modelSettings, effective: parseEffectiveModel(response) };
        await this.store.save(task.id, view);
        if (selection) verifyEffectiveModel(response, selection);
      }
      if (stopped) { await kill(); return; }
      beforeTurn();
      protocol = new CodexTurn(threadId, turn);
      const started = record(await request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], cwd: task.worktree, approvalPolicy: 'on-request',
        ...(selection ? { model: selection.model, effort: selection.effort } : {}),
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [task.worktree], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      } satisfies TurnStartParams));
      protocol.started(started.turn); this.changed();
    })().catch(error => { if (!stopped && !closing) fail(error); });
    this.changed();
  }
  approve(taskId: string, id: string, decision: 'accept' | 'decline'): void { const active = this.active.get(taskId); if (!active) throw new Error('No active Codex session.'); active.approve(id, decision); }
  async stop(id: string): Promise<void> { await this.active.get(id)?.stop(); }
  async finished(id: string): Promise<void> { await this.active.get(id)?.done; }
  async shutdown(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
