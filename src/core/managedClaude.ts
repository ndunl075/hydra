import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { claudeArguments, ClaudeProtocol, testedClaudeVersion } from './claudeProtocol';
import { claudeInitMatches, defaultPermissionMode, parsePermissionMode, permissionModeLabel } from './permissionMode';
import { parseContextUsage } from './contextUsage';
import { processLaunch, terminateProcessTree } from './process';
import { SessionStore } from './sessionStore';
import { ClaudeMessages, claudeRecord, readClaudeEffective, readClaudeModels } from './claudeControls';
import { parseModelSelection } from './modelSelection';
import type { Approval, SessionView, Task, Turn } from './model';

export interface ManagedTurnObserver { prepared?: (task: Task, turn: Turn) => Promise<void>; completed?: (task: Task, turn: Turn) => Promise<void>; sessionIdentified?: (task: Task, sessionId: string) => Promise<void> }

export class ManagedClaude {
  private readonly views = new Map<string, SessionView>();
  private readonly active = new Map<string, { stop: () => Promise<void>; done: Promise<void>; approve: (id: string, decision: 'accept' | 'decline') => void }>();
  private readonly starting = new Set<string>();
  constructor(readonly store: SessionStore, private readonly persistTask: () => Promise<void>, private readonly changed: () => void, private readonly report: (error: unknown) => void, private readonly terminate = terminateProcessTree, private readonly observer: ManagedTurnObserver = {}) {}
  get count(): number { return this.active.size; }
  has(id: string): boolean { return this.active.has(id); }
  view(id: string): SessionView | undefined { const view = this.views.get(id); return view ? { ...view, active: this.active.has(id) || this.starting.has(id) } : undefined; }
  displayView(id: string): SessionView | undefined {
    const view = this.view(id);
    return view ? { ...view, totalTurns: view.turns.length, turns: view.turns.slice(-10).map(turn => ({ ...turn, text: turn.text.slice(0, 50000), textTruncated: turn.text.length > 50000 })) } : undefined;
  }
  async load(task: Task): Promise<void> { this.views.set(task.id, await this.store.load(task.id)); }
  async start(task: Task, executable: string, prompt: string, beforeTurn: () => void | Promise<void> = () => {}, environment: Record<string, string> = {}): Promise<void> {
    if (this.starting.has(task.id) || this.has(task.id)) throw new Error('Stop the existing task writer before starting a managed turn.');
    this.starting.add(task.id);
    try { await this.startTurn(task, executable, prompt, beforeTurn, environment); }
    finally { this.starting.delete(task.id); }
  }
  private async startTurn(task: Task, executable: string, prompt: string, beforeTurn: () => void | Promise<void>, environment: Record<string, string>): Promise<void> {
    const expectedSchedule = task.schedule;
    if (task.provider !== 'claude' || task.providerVersion !== testedClaudeVersion) throw new Error('Managed Claude requires the tested CLI version 2.1.270. Check the configured provider first.');
    if (task.sessionId && task.sessionProvider && task.sessionProvider !== 'claude') throw new Error('This recorded session belongs to another provider. Create a separate Claude task.');
    if (task.interface === 'official-extension' || task.state === 'external' || this.has(task.id)) throw new Error('Stop the existing task writer before starting a managed turn.');
    if (!this.views.has(task.id)) await this.load(task);
    const view = this.views.get(task.id)!;
    if (view.writerUncertain) throw new Error('Stop surviving managed process children and reconcile writer absence before resuming.');
    const turn: Turn = { id: randomBytes(6).toString('hex'), provider: 'claude', prompt, text: '', status: 'running', createdAt: new Date().toISOString() };
    const selection = task.modelSelection ? parseModelSelection(task.modelSelection) : undefined;
    const previousModel = selection ? [...view.turns].reverse().find(item => item.modelSettings?.requested?.model === selection.model && item.modelSettings?.effective)?.modelSettings?.effective?.model : undefined;
    turn.modelSettings = selection ? { requested: selection } : undefined;
    const permissionMode = task.permissionMode ? parsePermissionMode(task.permissionMode, 'claude') : defaultPermissionMode('claude');
    const args = claudeArguments(task.sessionId, selection, permissionMode);
    view.turns.push(turn);
    task.interface = 'managed-cli'; task.state = 'running'; task.error = undefined; task.updatedAt = new Date().toISOString();
    let sequence = 0;
    try {
      await this.store.save(task.id, view);
      await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'start', cwd: task.worktree, version: testedClaudeVersion, args, prompt });
      await this.persistTask();
      if (expectedSchedule && (task.schedule !== expectedSchedule || expectedSchedule.state === 'cancelled')) {
        turn.status = 'interrupted'; turn.error = 'Cancelled before provider process started.';
        task.state = 'interrupted'; task.error = undefined;
        await this.store.save(task.id, view); await this.persistTask(); this.changed(); return;
      }
      await this.observer.prepared?.(task, structuredClone(turn));
      await beforeTurn();
    } catch (error) {
      turn.status = 'error'; turn.error = `Session setup failed: ${String(error)}`;
      task.state = 'error'; task.error = turn.error;
      throw error;
    }
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { cwd: task.worktree, env: { ...process.env, ...environment, DISABLE_AUTOUPDATER: '1' }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const protocol = new ClaudeProtocol(turn, task.worktree, task.sessionId, permissionMode);
    const stderr = new StringDecoder('utf8');
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const approvals = new Map<string, { requestId: string; input: Record<string, unknown>; toolUseId: string; approval: Approval }>();
    const seenRequests = new Set<string>();
    let failure: string | undefined, stopped = false, bytes = 0, nextId = 0, submitted = false, closing = false, finishing = false;
    // Optional requests that timed out; a late reply to one is dropped, not treated
    // as an unmatched response that would fail a turn that already completed.
    const abandoned = new Set<string>();
    let cleanup: Promise<void> | undefined;
    let sessionSave: Promise<void> = Promise.resolve();
    let sessionSaving = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const stop = async () => {
      stopped = true; approvals.clear(); view.approvals = []; rejectPending('Claude process stopped.'); this.changed();
      await kill();
      await done;
    };
    const kill = () => {
      if (!cleanup && child.pid && child.exitCode === null && child.signalCode === null) cleanup = this.terminate(child.pid).catch(error => { view.writerUncertain = true; this.changed(); this.report(error); failure ||= `Owned process cleanup failed: ${String(error)}`; child.kill(); });
      return cleanup;
    };
    const rejectPending = (reason: string) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); } pending.clear(); };
    const fail = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error.message : String(error);
      rejectPending(failure); approvals.clear(); view.approvals = []; void kill();
    };
    const log = (type: string, data: unknown) => { if (data) void this.store.log(task.id, turn.id, { sequence: ++sequence, type, data }).catch(fail); };
    const send = (message: unknown) => { if (stopped || closing || failure || child.exitCode !== null || child.signalCode !== null) throw new Error('Claude connection closed.'); log('stdin', message); child.stdin.write(JSON.stringify(message) + '\n'); };
    const request = (subtype: 'initialize' | 'get_settings' | 'get_binary_version' | 'get_context_usage', extra: Record<string, unknown> = {}, timeout = 15000, optional = false): Promise<unknown> => new Promise((resolve, reject) => {
      const request_id = `hydra-control-${++nextId}`;
      const timer = setTimeout(() => { pending.delete(request_id); if (optional) abandoned.add(request_id); reject(new Error(`Claude ${subtype} timed out. No turn submitted.`)); }, timeout);
      pending.set(request_id, { resolve, reject, timer });
      try { send({ type: 'control_request', request_id, request: { subtype, ...extra } }); } catch (error) { clearTimeout(timer); pending.delete(request_id); reject(error); }
    });
    const update = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => { saveTimer = undefined; void this.store.save(task.id, view).catch(fail); this.changed(); }, 250);
    };
    const approve = (id: string, decision: 'accept' | 'decline') => {
      const entry = approvals.get(id);
      if (!entry || !submitted || !protocol.initialized || protocol.resultReceived || stopped || closing || failure || sessionSaving) throw new Error('This Claude approval is no longer pending or its session identity is still saving.');
      send({ type: 'control_response', response: { subtype: 'success', request_id: entry.requestId, response: decision === 'accept' ? { behavior: 'allow', updatedInput: entry.input, toolUseID: entry.toolUseId } : { behavior: 'deny', message: 'This request was declined in Hydra.', toolUseID: entry.toolUseId } } });
      approvals.delete(id); view.approvals = sessionSaving ? [] : [...approvals.values()].map(entry => entry.approval); update(); this.changed();
    };
    this.active.set(task.id, { stop, done, approve });
    const messages = new ClaudeMessages(message => {
      if (message.type === 'control_response') {
        const response = claudeRecord(message.response), entry = pending.get(response.request_id);
        if (!entry) { if (abandoned.delete(response.request_id)) return; throw new Error('Unmatched Claude control response.'); }
        clearTimeout(entry.timer); pending.delete(response.request_id);
        // Effective/raw settings and account data never enter the diagnostic log.
        log('control-response', { requestId: response.request_id, subtype: response.subtype });
        if (response.subtype === 'success') entry.resolve(response.response);
        else entry.reject(new Error('Claude rejected initialization or settings inspection. No turn submitted; use the official client.'));
        return;
      }
      if (message.type === 'control_cancel_request') {
        if (typeof message.request_id !== 'string') throw new Error('Invalid Claude cancellation.');
        for (const [id, entry] of approvals) if (entry.requestId === message.request_id) approvals.delete(id);
        view.approvals = sessionSaving ? [] : [...approvals.values()].map(entry => entry.approval); update(); this.changed(); return;
      }
      if (message.type === 'control_request') {
        const request = claudeRecord(message.request), requestId = message.request_id;
        if (!submitted || !protocol.initialized || protocol.resultReceived || stopped || closing || typeof requestId !== 'string' || !requestId || requestId.length > 200 || seenRequests.has(requestId) || seenRequests.size >= 1000) throw new Error('Invalid or duplicate Claude approval request.');
        seenRequests.add(requestId);
        // The permission mode is chosen before launch and locked for the task, so a
        // request to leave plan mode is denied rather than quietly promoted into a
        // writing turn. The plan itself is already in the transcript; executing it
        // means starting a new task. Denying keeps the turn alive to finish its reply.
        if (request.subtype === 'can_use_tool' && request.tool_name === 'ExitPlanMode' && typeof request.tool_use_id === 'string' && request.tool_use_id && request.tool_use_id.length <= 200) {
          send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: 'This task runs in plan mode, which is locked for the task. Start a new task to execute the plan.', toolUseID: request.tool_use_id } } });
          log('plan-mode-exit-denied', { requestId, toolUseId: request.tool_use_id });
          return;
        }
        if (request.subtype !== 'can_use_tool' || request.requires_user_interaction === true || request.agent_id || request.decision_reason_type === 'asyncAgent' || !['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit'].includes(request.tool_name) || typeof request.tool_use_id !== 'string' || !request.tool_use_id || request.tool_use_id.length > 200) throw new Error('Unsupported Claude interaction. No permission granted; use the official interactive client.');
        const input = claudeRecord(request.input), detail = JSON.stringify({ tool: request.tool_name, input, blockedPath: request.blocked_path, reason: request.decision_reason, reasonType: request.decision_reason_type, defaultToNo: request.default_to_no }, null, 2);
        if (detail.length > 50000 || approvals.size >= 20) throw new Error('Claude approval exceeded display limits. No permission granted; use the official client.');
        const id = randomBytes(6).toString('hex'), approval: Approval = { id, kind: ['Bash', 'PowerShell'].includes(request.tool_name) ? 'command' : 'file', detail };
        approvals.set(id, { requestId, input, toolUseId: request.tool_use_id, approval });
        view.approvals = sessionSaving ? [] : [...approvals.values()].map(entry => entry.approval); log('approval-request', { requestId, approval }); update(); this.changed(); return;
      }
      if (!submitted) throw new Error('Claude emitted a non-control event before settings were verified. No turn submitted.');
      log('stdout', JSON.stringify(message) + '\n');
      protocol.push(Buffer.from(JSON.stringify(message) + '\n'));
      if (protocol.sessionId && task.sessionId !== protocol.sessionId) {
        const sessionId = protocol.sessionId;
        task.sessionId = sessionId; task.sessionProvider = 'claude'; sessionSaving = true;
        sessionSave = this.persistTask().then(() => this.observer.sessionIdentified?.(task, sessionId)).catch(fail).finally(() => { sessionSaving = false; view.approvals = [...approvals.values()].map(entry => entry.approval); this.changed(); });
      }
      if (message.type === 'system' && message.subtype === 'init' && selection && message.model !== turn.modelSettings?.effective?.model) throw new Error('Claude initialization changed the acknowledged model. Turn stopped; inspect provider settings.');
      if (protocol.resultReceived && !closing && !finishing) {
        if (approvals.size) throw new Error('Claude completed while approval was still pending.');
        finishing = true;
        // A read-only snapshot for the composer's usage ring, taken before stdin
        // closes. It is optional: a rejection, malformed reply or timeout leaves the
        // finished turn exactly as it was. Nothing here compacts or changes context.
        void (async () => {
          try { const usage = parseContextUsage(await request('get_context_usage', { detail: 'summary' }, 3000, true)); if (usage) { turn.contextUsage = usage; update(); } }
          catch { /* The ring stays empty for this turn. */ }
          finally { if (!closing) { closing = true; try { child.stdin.end(); } catch { /* already closed */ } closeTimer = setTimeout(() => { void kill(); }, 3000); } }
        })();
      }
      update();
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) { fail(new Error('Managed output exceeded 32 MiB. Available evidence is retained; process stopped.')); return; }
      if (failure) return;
      try {
        messages.push(data);
      } catch (error) { fail(error); }
    });
    child.stderr.on('data', (data: Buffer) => { log('stderr', stderr.write(data)); bytes += data.length; if (bytes > 32 * 1024 * 1024) fail(new Error('Managed output exceeded 32 MiB. Available evidence is retained; process stopped.')); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('close', code => {
      void (async () => {
        clearTimeout(saveTimer); clearTimeout(closeTimer); rejectPending('Claude connection closed.');
        await cleanup; approvals.clear(); view.approvals = [];
        log('stderr', stderr.end());
        if (!failure) try { messages.end(); protocol.end(); } catch (error) { failure = String(error); }
        // A rapid result/exit cannot publish completion before the session receipt is durable.
        await sessionSave;
        if (protocol.sessionId) { task.sessionId = protocol.sessionId; task.sessionProvider = 'claude'; }
        turn.status = stopped ? 'interrupted' : failure || code !== 0 || !protocol.resultReceived || turn.error ? 'error' : 'completed';
        if (turn.status !== 'completed') turn.error = failure || turn.error || (stopped ? 'Provider process stopped. The turn was not completed.' : `Provider exited ${code} without a valid successful result.`);
        task.state = turn.status === 'completed' ? 'idle' : turn.status;
        task.error = turn.error; task.updatedAt = new Date().toISOString();
        try {
          await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'exit', code, status: turn.status, error: turn.error });
          await this.store.save(task.id, view);
        } catch (error) { turn.status = 'error'; task.state = 'error'; task.error = `Session storage failed: ${String(error)}`; this.report(error); }
        // Retain ownership until the process closed and the metadata save was attempted.
        try { await this.persistTask(); await this.observer.completed?.(task, structuredClone(turn)); } catch (error) { this.report(error); }
        finally { this.active.delete(task.id); this.changed(); resolveDone(); }
      })().catch(error => { this.report(error); this.active.delete(task.id); resolveDone(); });
    });
    void (async () => {
      const init = claudeRecord(await request('initialize'));
      const version = claudeRecord(await request('get_binary_version'));
      if (version.version !== testedClaudeVersion) throw new Error('Claude pre-turn initialization did not match the tested version. No turn submitted.');
      if (!claudeInitMatches(permissionMode, init.current_permission_mode)) throw new Error(`Claude reports ${String(init.current_permission_mode)} instead of the requested ${permissionModeLabel(permissionMode)} permission mode. No turn submitted.`);
      const models = readClaudeModels(init.models);
      const effective = readClaudeEffective(await request('get_settings'), models, selection);
      if (previousModel && effective.model !== previousModel) throw new Error('Claude changed the canonical identity of this saved model alias. No turn submitted; create a new task to accept the new model.');
      turn.modelSettings = { ...turn.modelSettings, effective };
      await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'effective-settings', data: effective });
      await this.store.save(task.id, view); await this.persistTask();
      if (stopped || closing || failure) return;
      await beforeTurn(); if (stopped || closing || failure) return; submitted = true;
      send({ type: 'user', session_id: task.sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: prompt } });
    })().catch(error => { if (!stopped) fail(error); });
    this.changed();
  }
  approve(taskId: string, id: string, decision: 'accept' | 'decline'): void { const active = this.active.get(taskId); if (!active) throw new Error('No active Claude session.'); active.approve(id, decision); }
  async stop(id: string): Promise<void> { await this.active.get(id)?.stop(); }
  async finished(id: string): Promise<void> { await this.active.get(id)?.done; }
  async shutdown(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
