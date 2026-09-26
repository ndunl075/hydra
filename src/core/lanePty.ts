import path from 'node:path';
import { terminateProcessTree } from './process';

/**
 * Lane terminals (docs/Lanes_And_Planner_Plan.md, "Terminals"). node-pty comes
 * from the host application, never bundled: the Hydra desktop build and VS Code
 * both ship it. If it doesn't load, lanes can't start and nothing else breaks.
 */
export interface PtyDisposable { dispose(): void }
/** The part of node-pty's IPty that lanes use, so tests can use a fake. */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable | void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtySpawnOptions { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
export interface PtyModule { spawn(file: string, args: string[], options: PtySpawnOptions): PtyLike }

export const terminalsUnavailable = 'Terminals aren\'t available in this build.';

/** Where the host keeps node-pty, in the order tried: unpacked, then beside the asar archive, then inside it. */
export function ptyCandidates(appRoot: string): string[] {
  return ['node_modules', 'node_modules.asar.unpacked', 'node_modules.asar'].map(folder => path.join(appRoot, folder, 'node-pty'));
}

/** Load node-pty from the host (`vscode.env.appRoot`). `module` is undefined when none of the candidates loads. */
export function loadNodePty(appRoot: string | undefined, load: (id: string) => unknown = id => require(id)): { module?: PtyModule; tried: string[]; errors: string[] } {
  const tried: string[] = [], errors: string[] = [];
  if (!appRoot) return { tried, errors: ['The host application folder is unknown.'] };
  for (const candidate of ptyCandidates(appRoot)) {
    tried.push(candidate);
    try {
      const loaded = load(candidate) as Partial<PtyModule> | undefined;
      if (loaded && typeof loaded.spawn === 'function') return { module: loaded as PtyModule, tried, errors };
      errors.push(`${candidate}: no spawn function`);
    } catch (error) { errors.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
  }
  return { tried, errors };
}

/**
 * 1.3 (docs/Hydra_Improvements.md): strip terminal control sequences from text Hydra itself is
 * about to type into a lane (never applied to `LaneService.input`, which carries the user's own
 * keystrokes — arrow keys and the like are escape sequences on purpose). Removes CSI sequences
 * (`ESC [ … final byte`, which covers bracketed-paste markers `ESC[200~`/`ESC[201~`), OSC
 * sequences (`ESC ] … BEL` or `ESC ] … ESC \`), any other `ESC` plus one character, and C0/C1
 * control characters; line breaks and tabs become spaces rather than vanishing, so words don't
 * run together. A head's gate output, once it reaches here, reads as plain text.
 */
export function terminalText(text: string): string {
  return text
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[\s\S]?/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\u0080-\u009f]/g, '');
}

export const replayLimit = 256 * 1024;
export const batchMs = 16;
export const minCols = 20, maxCols = 500, minRows = 5, maxRows = 200;

export interface LaneTerminalOptions {
  /** Output, batched (at most one call every batchMs). */
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
  /** Stops the process tree; defaults to taskkill /T /F on Windows and a process-group kill elsewhere. */
  killTree?: (pid: number) => Promise<void>;
  batchMs?: number;
  /** The most output kept for replay, in characters. */
  replayLimit?: number;
  /** Output kept from the lane's previous session, so a resumed lane replays its history. */
  initialReplay?: string;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * One lane process in a pseudo-terminal. Output is batched every 16 ms and kept
 * in a ring buffer that is replayed when the webview (re)attaches.
 */
export class LaneTerminal {
  private pending = '';
  private timer: unknown;
  private chunks: string[] = [];
  private size = 0;
  private alive = true;
  private code?: number;
  private resolveExit!: (code: number) => void;
  /** Resolves with the exit code once the process is gone. */
  readonly exited: Promise<number>;
  private readonly limit: number;
  constructor(private readonly pty: PtyLike, private readonly options: LaneTerminalOptions = {}) {
    this.limit = Math.max(1024, options.replayLimit ?? replayLimit);
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    if (options.initialReplay) this.keep(options.initialReplay);
    pty.onData(data => this.received(data));
    pty.onExit(event => this.ended(typeof event?.exitCode === 'number' ? event.exitCode : -1));
  }

  get running(): boolean { return this.alive; }
  get exitCode(): number | undefined { return this.code; }
  get pid(): number { return this.pty.pid; }

  write(data: string): void {
    if (!this.alive) return;
    try { this.pty.write(data); } catch { /* the process is exiting */ }
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < minCols || cols > maxCols || rows < minRows || rows > maxRows) throw new Error('Invalid terminal size.');
    if (!this.alive) return;
    try { this.pty.resize(cols, rows); } catch { /* resizing an exiting pty throws; the next resize wins */ }
  }

  /** Everything kept for replay, including output not yet flushed. */
  replay(): string { this.flush(); return this.chunks.join(''); }

  /**
   * Stop the process and everything it started: a tree kill first (so a CLI's
   * own children go too), then the pty itself. Waits briefly for the exit.
   */
  async kill(): Promise<void> {
    if (!this.alive) return;
    const pid = this.pty.pid;
    if (pid > 0) await (this.options.killTree ?? terminateProcessTree)(pid).catch(() => undefined);
    try { this.pty.kill(); } catch { /* already gone */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    if (timer) clearTimeout(timer);
    // A pty that never reports its exit is treated as gone.
    if (this.alive) this.ended(-1);
  }

  private received(data: string): void {
    if (typeof data !== 'string' || !data) return;
    this.pending += data;
    if (this.pending.length >= this.limit) { this.flush(); return; }
    if (this.timer === undefined) this.timer = (this.options.schedule ?? setTimeout)(() => { this.timer = undefined; this.flush(); }, this.options.batchMs ?? batchMs);
  }

  private flush(): void {
    if (this.timer !== undefined) { (this.options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer); this.timer = undefined; }
    if (!this.pending) return;
    const data = this.pending;
    this.pending = '';
    this.keep(data);
    this.options.onData?.(data);
  }

  /** Append to the ring buffer, dropping the oldest output past the limit (at a line break when one is near). */
  private keep(data: string): void {
    this.chunks.push(data); this.size += data.length;
    while (this.size > this.limit && this.chunks.length) {
      const excess = this.size - this.limit, first = this.chunks[0]!;
      if (first.length <= excess) { this.chunks.shift(); this.size -= first.length; continue; }
      let cut = excess;
      const newline = first.indexOf('\n', cut);
      if (newline >= 0 && newline - cut < 4096) cut = newline + 1;
      // Never split a surrogate pair.
      else if (/[\uDC00-\uDFFF]/.test(first[cut] ?? '')) cut++;
      this.chunks[0] = first.slice(cut); this.size -= cut;
    }
  }

  private ended(code: number): void {
    if (!this.alive) return;
    this.flush();
    this.alive = false; this.code = code;
    this.resolveExit(code);
    this.options.onExit?.(code);
  }
}
