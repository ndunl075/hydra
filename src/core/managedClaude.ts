import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { claudeArguments, ClaudeProtocol, testedClaudeVersion } from './claudeProtocol';
import { processLaunch, terminateProcessTree } from './process';
import { SessionStore } from './sessionStore';
import type { SessionView, Task, Turn } from './model';

export class ManagedClaude {
  private readonly views = new Map<string, SessionView>();
  private readonly active = new Map<string, { stop: () => Promise<void>; done: Promise<void> }>();
  private readonly starting = new Set<string>();
  constructor(readonly store: SessionStore, private readonly persistTask: () => Promise<void>, private readonly changed: () => void, private readonly report: (error: unknown) => void) {}
  get count(): number { return this.active.size; }
  has(id: string): boolean { return this.active.has(id); }
  view(id: string): SessionView | undefined { const view = this.views.get(id); return view ? { ...view, active: this.active.has(id) || this.starting.has(id) } : undefined; }
  displayView(id: string): SessionView | undefined {
    const view = this.view(id);
    return view ? { ...view, totalTurns: view.turns.length, turns: view.turns.slice(-10).map(turn => ({ ...turn, text: turn.text.slice(0, 50000), textTruncated: turn.text.length > 50000 })) } : undefined;
  }
  async load(task: Task): Promise<void> { this.views.set(task.id, await this.store.load(task.id)); }
  async start(task: Task, executable: string, prompt: string): Promise<void> {
    if (this.starting.has(task.id) || this.has(task.id)) throw new Error('Stop the existing task writer before starting a managed turn.');
    this.starting.add(task.id);
    try { await this.startTurn(task, executable, prompt); }
    finally { this.starting.delete(task.id); }
  }
  private async startTurn(task: Task, executable: string, prompt: string): Promise<void> {
    if (task.provider !== 'claude' || task.providerVersion !== testedClaudeVersion) throw new Error('Managed Claude requires the tested CLI version 2.1.270. Check the configured provider first.');
    if (task.interface === 'official-extension' || task.state === 'external' || this.has(task.id)) throw new Error('Stop the existing task writer before starting a managed turn.');
    if (!this.views.has(task.id)) await this.load(task);
    const view = this.views.get(task.id)!;
    const turn: Turn = { id: randomBytes(6).toString('hex'), prompt, text: '', status: 'running', createdAt: new Date().toISOString() };
    const args = claudeArguments(task.sessionId);
    view.turns.push(turn);
    task.interface = 'managed-cli'; task.state = 'running'; task.error = undefined; task.updatedAt = new Date().toISOString();
    let sequence = 0;
    try {
      await this.store.save(task.id, view);
      await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'start', cwd: task.worktree, version: testedClaudeVersion, args, prompt });
      await this.persistTask();
    } catch (error) {
      turn.status = 'error'; turn.error = `Session setup failed: ${String(error)}`;
      task.state = 'error'; task.error = turn.error;
      throw error;
    }
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { cwd: task.worktree, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const protocol = new ClaudeProtocol(turn, task.worktree, task.sessionId);
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    let failure: string | undefined, stopped = false, bytes = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const stop = async () => {
      stopped = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) await terminateProcessTree(child.pid);
      await done;
    };
    this.active.set(task.id, { stop, done });
    const fail = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error.message : String(error);
      if (child.pid && child.exitCode === null && child.signalCode === null) void terminateProcessTree(child.pid).catch(this.report);
    };
    const log = (type: string, data: string) => { if (data) void this.store.log(task.id, turn.id, { sequence: ++sequence, type, data }).catch(fail); };
    const update = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => { saveTimer = undefined; void this.store.save(task.id, view).catch(fail); this.changed(); }, 250);
    };
    child.stdout.on('data', (data: Buffer) => {
      log('stdout', stdout.write(data)); bytes += data.length;
      if (bytes > 32 * 1024 * 1024) { fail(new Error('Managed output exceeded 32 MiB. Available evidence is retained; process stopped.')); return; }
      if (failure) return;
      try {
        protocol.push(data);
        if (protocol.sessionId && task.sessionId !== protocol.sessionId) {
          task.sessionId = protocol.sessionId;
          void this.persistTask().catch(fail);
        }
        update();
      } catch (error) { fail(error); }
    });
    child.stderr.on('data', (data: Buffer) => { log('stderr', stderr.write(data)); bytes += data.length; if (bytes > 32 * 1024 * 1024) fail(new Error('Managed output exceeded 32 MiB. Available evidence is retained; process stopped.')); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('close', code => {
      void (async () => {
        clearTimeout(saveTimer);
        log('stdout', stdout.end()); log('stderr', stderr.end());
        if (!failure) try { protocol.end(); } catch (error) { failure = String(error); }
        if (protocol.sessionId) task.sessionId = protocol.sessionId;
        turn.status = stopped ? 'interrupted' : failure || code !== 0 || !protocol.resultReceived || turn.error ? 'error' : 'completed';
        if (turn.status !== 'completed') turn.error = failure || turn.error || (stopped ? 'Provider process stopped. The turn was not completed.' : `Provider exited ${code} without a valid successful result.`);
        task.state = turn.status === 'completed' ? 'idle' : turn.status;
        task.error = turn.error; task.updatedAt = new Date().toISOString();
        try {
          await this.store.log(task.id, turn.id, { sequence: ++sequence, type: 'exit', code, status: turn.status, error: turn.error });
          await this.store.save(task.id, view);
        } catch (error) { turn.status = 'error'; task.state = 'error'; task.error = `Session storage failed: ${String(error)}`; this.report(error); }
        // Retain ownership until the process closed and the metadata save was attempted.
        try { await this.persistTask(); } catch (error) { this.report(error); }
        finally { this.active.delete(task.id); this.changed(); resolveDone(); }
      })().catch(error => { this.report(error); this.active.delete(task.id); resolveDone(); });
    });
    child.stdin.end(prompt);
    this.changed();
  }
  async stop(id: string): Promise<void> { await this.active.get(id)?.stop(); }
  async finished(id: string): Promise<void> { await this.active.get(id)?.done; }
  async shutdown(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
