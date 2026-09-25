import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitRun } from './git';
import { processLaunch } from './process';
import { createWorktree, defaultWorktreeRoot } from './worktrees';
import { LaneTerminal, minCols, maxCols, minRows, maxRows, terminalsUnavailable, type PtyModule } from './lanePty';
import { LaneSync, syncIntervalMs } from './laneSync';
import { checkMerge, closeLaneWorktree, commitLane, laneFullyMerged, mergeLane, pushLane, updateLane, type CloseMode, type MergeCheck } from './laneFinish';
import { isLaneId, isSafeBranchName, laneBranch, laneFolder, lanePreamble, newLaneId, parseLaneInput, type Lane, type LanePreambleOther, type LaneStore } from './lanes';
import type { HelperServerSpec } from './helperRegistration';
import type { LaneSyncView, LaneView, Provider } from './model';

/**
 * Hydra lanes, end to end (docs/Lanes_And_Planner_Plan.md, section 1): this
 * window's lanes and their terminals. It starts each lane's `claude` or `codex`
 * in its own worktree, keeps the lanes' coordination fresh, and runs the
 * finishing git operations the user asks for. It has no UI of its own; the
 * extension asks for confirmation before calling the actions that need it.
 */

// ---- Launching a lane's CLI ----

export interface LaneLaunchInput {
  lane: Pick<Lane, 'id' | 'name' | 'branch' | 'provider'>;
  /** The CLI from findProvider (ignored when testCommand is set). */
  executable: string;
  /** Continue the lane's last conversation: Claude `--continue`, Codex `resume --last`. */
  resume: boolean;
  /** The first prompt of a fresh start with a goal. */
  prompt?: string;
  /** The provider already has Hydra's server at user level; otherwise it is passed for this process only. */
  connected: boolean;
  /** How the CLI starts Hydra's bridge (helperServerSpec). */
  bridge: HelperServerSpec;
  /** Where Claude's `--mcp-config` file goes; the caller writes `mcpConfig` there. */
  mcpConfigFile: string;
  /** This window's helpers folder, as the heads bridge uses. */
  helpersDir: string;
  /** HYDRA_TEST_LANE_COMMAND: run this instead of the CLI (smoke tests). */
  testCommand?: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
export interface LaneLaunch { executable: string; args: string[]; env: Record<string, string>; mcpConfig?: string }

/** A TOML literal string. Lane values never contain a quote or line break; refuse rather than mis-quote. */
const toml = (value: string) => { if (value.includes("'") || /[\r\n]/.test(value)) throw new Error('A lane setting contains a quote or line break.'); return `'${value}'`; };

/**
 * Text passed through a Windows `.cmd` shim is read by cmd.exe, which expands
 * `%` and treats `& | < > ^ !` as syntax. The prompt keeps to characters cmd
 * reads literally: double quotes become single ones, the rest become spaces.
 */
export function shimSafe(text: string): string {
  return text.replace(/"/g, '\'').replace(/[%^&|<>!\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\\+$/, '');
}

/** HYDRA_TEST_LANE_COMMAND: a JSON array `[executable, ...args]`, or one executable path. */
export function parseTestCommand(value: string): { executable: string; args: string[] } {
  const text = value.trim();
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(part => typeof part !== 'string' || !part)) throw new Error('HYDRA_TEST_LANE_COMMAND must be a JSON array of strings.');
    return { executable: parsed[0] as string, args: parsed.slice(1) as string[] };
  }
  if (!text) throw new Error('HYDRA_TEST_LANE_COMMAND is empty.');
  return { executable: text, args: [] };
}

/**
 * The command line and environment of a lane's CLI. The environment is the
 * host's plus the lane's identity (HYDRA_LANE_ID, its name and branch, for the
 * bridge), HYDRA_LEAD_PROVIDER, HYDRA_HELPERS_DIR and a colour terminal.
 */
export function laneLaunch(input: LaneLaunchInput): LaneLaunch {
  const { lane } = input;
  // HYDRA_LANE_HELPERS_DIR names this window even when the user-level server's own
  // HYDRA_HELPERS_DIR (which wins over ours) belongs to another Hydra profile.
  const laneEnv = { HYDRA_LANE_ID: lane.id, HYDRA_LANE_NAME: lane.name, HYDRA_LANE_BRANCH: lane.branch, HYDRA_LANE_HELPERS_DIR: input.helpersDir };
  const env: Record<string, string> = {};
  // The host may run as Node; the lane's own tools must not inherit that.
  for (const [key, value] of Object.entries(input.env)) if (typeof value === 'string' && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  Object.assign(env, laneEnv, { HYDRA_LEAD_PROVIDER: lane.provider, HYDRA_HELPERS_DIR: input.helpersDir, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  if (input.testCommand) return { ...parseTestCommand(input.testCommand), env };
  const shim = (input.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(input.executable);
  const prompt = input.prompt && !input.resume ? (shim ? shimSafe(input.prompt) : input.prompt) : undefined;
  // The bridge reads the lane from its environment. Claude passes its own environment
  // on to the servers it starts; Codex doesn't, so the lane's values go into its server config.
  const serverEnv = { ...input.bridge.env, ...laneEnv };
  if (lane.provider === 'claude') {
    const mcp = input.connected ? [] : ['--mcp-config', input.mcpConfigFile];
    const mcpConfig = input.connected ? undefined : JSON.stringify({ mcpServers: { hydra: { type: 'stdio', command: input.bridge.command, args: input.bridge.args, env: serverEnv, timeout: 3_600_000 } } }, null, 2);
    return { executable: input.executable, args: input.resume ? ['--continue', ...mcp] : [...mcp, ...(prompt ? [prompt] : [])], env, ...(mcpConfig ? { mcpConfig } : {}) };
  }
  const config = (key: string, value: string) => ['-c', `mcp_servers.hydra.${key}=${value}`];
  const overrides = input.connected
    ? Object.entries(laneEnv).flatMap(([key, value]) => config(`env.${key}`, toml(value)))
    : [
      ...config('command', toml(input.bridge.command)), ...config('args', `[${input.bridge.args.map(toml).join(', ')}]`),
      ...config('env', `{ ${Object.entries(serverEnv).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`),
      ...config('startup_timeout_sec', '30'), ...config('tool_timeout_sec', '3600'), ...config('default_tools_approval_mode', '\'approve\''),
    ];
  return { executable: input.executable, args: input.resume ? [...overrides, 'resume', '--last'] : [...overrides, ...(prompt ? [prompt] : [])], env };
}

// ---- The service ----

export interface LaneServiceOptions {
  store: LaneStore;
  /** The main checkout's root: lanes branch from its HEAD and merge back into it. */
  repository: string;
  worktreeRoot: () => string | undefined;
  /** node-pty from the host; undefined when this build has none. */
  pty?: PtyModule;
  /** The provider CLI; throws a clear reason if it isn't installed. */
  executable: (provider: Provider) => Promise<string>;
  /** Whether the provider is connected to Hydra at user level. */
  connected: (provider: Provider) => Promise<boolean>;
  bridge: (provider: Provider) => HelperServerSpec;
  helpersDir: string;
  /** Where per-lane MCP config files go. */
  configDirectory: string;
  /** HYDRA_TEST_LANE_COMMAND, read at each launch. */
  testCommand?: () => string | undefined;
  /** Unfinished heads started from a lane. */
  runningHeads?: (laneId: string) => number;
  onChange?: () => void;
  onData?: (id: string, data: string) => void;
  log?: (line: string) => void;
  killTree?: (pid: number) => Promise<void>;
  env?: () => NodeJS.ProcessEnv;
  syncIntervalMs?: number;
  now?: () => Date;
}

export const maxOpenLanes = 24;
export const defaultTerminalSize = { cols: 100, rows: 30 };

export class LaneService {
  private readonly terminals = new Map<string, LaneTerminal>();
  private readonly sizes = new Map<string, { cols: number; rows: number }>();
  private readonly busy = new Set<string>();
  private results = new Map<string, LaneSyncView>();
  private readonly syncer: LaneSync;
  private syncRun?: Promise<void>;
  private syncNext?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(private readonly options: LaneServiceOptions) { this.syncer = new LaneSync(options.now); }

  get terminalsAvailable(): boolean { return !!this.options.pty; }

  /** After the store is loaded: start the coordination cadence if any lane is open. */
  activate(): void { this.schedule(); if (this.lanes().length) void this.sync().catch(() => undefined); }

  /** Open lanes (not closed), oldest first. */
  lanes(): Lane[] { return this.options.store.open(); }
  exists(id: string): boolean { const lane = isLaneId(id) ? this.options.store.get(id) : undefined; return !!lane && lane.state !== 'closed'; }
  name(id: string): string | undefined { return this.exists(id) ? this.options.store.get(id)!.name : undefined; }
  get(id: string): Lane | undefined { return this.exists(id) ? this.options.store.get(id) : undefined; }
  /** Open lanes' worktrees, for the window's discovery record. */
  openWorktrees(): string[] { return this.lanes().map(lane => lane.worktree); }
  views(): LaneView[] {
    return this.lanes().map(lane => {
      const sync = this.results.get(lane.id);
      return { ...lane, ...(sync ? { sync: structuredClone(sync) } : {}), running: !!this.terminals.get(lane.id)?.running };
    });
  }

  /** Start a lane: a worktree and branch from the main checkout's HEAD, and its CLI in a terminal. */
  async create(value: unknown): Promise<Lane> {
    const input = parseLaneInput(value);
    if (!this.options.pty) throw new Error(terminalsUnavailable);
    if (this.disposed) throw new Error('This Hydra window is closing.');
    if (this.lanes().length >= maxOpenLanes) throw new Error(`This window already has ${maxOpenLanes} open lanes. Close some first.`);
    const testCommand = this.options.testCommand?.();
    // A missing CLI fails before anything is created.
    const executable = testCommand ? '' : await this.options.executable(input.provider);
    const head = await gitRun(this.options.repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const current = head.code === 0 ? head.stdout.trim() : '';
    if (!current) throw new Error('The main checkout isn\'t on a branch. Check out a branch to start a lane.');
    if (!isSafeBranchName(current)) throw new Error(`Hydra can't start a lane from the branch "${current}". Use a branch named with letters, numbers and . _ / - only.`);
    let id: string; do { id = newLaneId(); } while (this.options.store.get(id));
    const created = await createWorktree(this.options.repository, input.name, id, this.options.worktreeRoot(), undefined, { branch: laneBranch(input.name, id), folder: laneFolder(id) });
    const lane: Lane = {
      id, name: input.name, provider: input.provider, ...(input.goal ? { goal: input.goal } : {}),
      repository: this.options.repository, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit,
      target: isSafeBranchName(created.integrationTarget) ? created.integrationTarget : current,
      createdAt: this.now().toISOString(), state: 'running',
    };
    this.busy.add(id);
    try {
      await this.options.store.add(lane);
      // The first prompt lists what the other lanes are changing, so check them first.
      if (lane.goal && this.lanes().length > 1) await this.sync().catch(() => undefined);
      await this.launch(lane, false, executable);
    } catch (error) {
      await this.rollback(lane).catch(failure => this.options.log?.(`[lanes] ${id}: could not undo the start: ${describe(failure)}`));
      throw error;
    } finally { this.busy.delete(id); }
    this.changed(); this.schedule(); void this.sync().catch(() => undefined);
    return this.options.store.get(id)!;
  }

  /** Continue the lane's last conversation in a new terminal. */
  async resume(id: unknown): Promise<void> {
    await this.exclusive(id, async lane => {
      if (this.terminals.get(lane.id)?.running) throw new Error(`Lane ${lane.name} is already running.`);
      await this.relaunch(lane, true);
    });
  }

  /** Start fresh: stop the lane's CLI if it runs, then start a new conversation (with the goal's first prompt). */
  async restart(id: unknown): Promise<void> {
    await this.exclusive(id, async lane => {
      await this.terminals.get(lane.id)?.kill();
      await this.relaunch(this.options.store.get(lane.id)!, false);
    });
  }

  /** Keys typed in the lane's tile. Ignored when its terminal isn't running. */
  input(id: unknown, data: string): boolean {
    const terminal = isLaneId(id) ? this.terminals.get(id) : undefined;
    if (!terminal?.running) return false;
    terminal.write(data);
    return true;
  }

  resize(id: unknown, cols: number, rows: number): void {
    if (!isLaneId(id) || !this.exists(id)) throw new Error('That lane isn\'t open in this window.');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < minCols || cols > maxCols || rows < minRows || rows > maxRows) throw new Error('Invalid terminal size.');
    this.sizes.set(id, { cols, rows });
    this.terminals.get(id)?.resize(cols, rows);
  }

  /** Every open lane's replay buffer, for a webview that (re)attaches. */
  replay(): { id: string; data: string }[] {
    return this.lanes().flatMap(lane => { const terminal = this.terminals.get(lane.id); return terminal ? [{ id: lane.id, data: terminal.replay() }] : []; });
  }
  replayOf(id: unknown): string {
    if (!isLaneId(id)) throw new Error('Invalid lane ID.');
    return this.terminals.get(id)?.replay() ?? '';
  }

  // ---- Finishing ----

  /** Commit everything in the lane. Undefined when there was nothing to commit. */
  async commit(id: unknown, message?: string): Promise<string | undefined> {
    return this.exclusive(id, async lane => {
      const commit = await commitLane(lane, message);
      if (commit) this.afterGit();
      return commit;
    });
  }
  async checkMerge(id: unknown): Promise<MergeCheck> { return this.exclusive(id, lane => checkMerge(lane)); }
  /** Merge into the target (checked again first). The lane becomes merged. */
  async merge(id: unknown): Promise<string> {
    return this.exclusive(id, async lane => {
      const commit = await mergeLane(lane);
      await this.options.store.update(lane.id, { state: 'merged', mergedAt: this.now().toISOString() });
      this.options.log?.(`[lanes] ${lane.id} merged into ${lane.target} (${commit.slice(0, 12)})`);
      this.afterGit();
      return commit;
    });
  }
  async update(id: unknown): Promise<{ conflicts: string[]; upToDate: boolean }> {
    return this.exclusive(id, async lane => { const result = await updateLane(lane); this.afterGit(); return result; });
  }
  async push(id: unknown): Promise<{ branch: string; compareUrl?: string }> { return this.exclusive(id, lane => pushLane(lane)); }
  /** How a lane closes: quietly when it is merged (or has nothing to lose), else the user chooses keep or delete. */
  async closeKind(id: unknown): Promise<'merged' | 'unmerged'> {
    const lane = this.openLane(id);
    return lane.state === 'merged' || await laneFullyMerged(lane).catch(() => false) ? 'merged' : 'unmerged';
  }
  /** Stop the lane's terminal, then remove its worktree (and branch, unless kept). The lane becomes closed. */
  async close(id: unknown, mode: CloseMode): Promise<{ unlinked: string[] }> {
    if (mode !== 'merged' && mode !== 'keep' && mode !== 'delete') throw new Error('Choose how to close the lane.');
    return this.exclusive(id, async lane => {
      if (mode === 'merged' && lane.state !== 'merged' && !await laneFullyMerged(lane)) throw new Error(`Lane ${lane.name} isn't merged. Choose Keep branch or Delete everything.`);
      await this.terminals.get(lane.id)?.kill();
      const result = await closeLaneWorktree(lane, mode, this.roots(lane), this.lanes().map(open => open.worktree));
      await rm(this.mcpConfigFile(lane.id), { force: true }).catch(() => undefined);
      await this.options.store.update(lane.id, { state: 'closed' });
      this.terminals.delete(lane.id); this.sizes.delete(lane.id); this.results.delete(lane.id);
      this.options.log?.(`[lanes] ${lane.id} closed (${mode})${result.unlinked.length ? `; unlinked ${result.unlinked.length} link(s) first` : ''}`);
      this.changed(); this.schedule(); void this.sync().catch(() => undefined);
      return result;
    });
  }

  // ---- Coordination ----

  /** A fresh coordination pass. A request during a pass runs one more pass after it, so the answer is never stale. */
  sync(): Promise<void> {
    if (!this.syncRun) {
      this.syncRun = this.runSync().finally(() => { this.syncRun = undefined; });
      return this.syncRun;
    }
    this.syncNext ??= this.syncRun.catch(() => undefined).then(() => { this.syncNext = undefined; return this.sync(); });
    return this.syncNext;
  }

  /** The hydra_lanes answer: every open lane, checked fresh. `you` is the caller's own lane. */
  async describe(you?: string) {
    await this.sync();
    return {
      ...(you && this.exists(you) ? { you } : {}),
      lanes: this.lanes().map(lane => {
        const sync = this.results.get(lane.id);
        return {
          id: lane.id, name: lane.name, provider: lane.provider, ...(lane.goal ? { goal: lane.goal } : {}), branch: lane.branch, target: lane.target, state: lane.state,
          changedFiles: (sync?.changedFiles ?? []).slice(0, 40), ...(sync && sync.changedFiles.length > 40 ? { changedFilesTotal: sync.changedFiles.length } : {}),
          conflictsWith: (sync?.conflicts ?? []).map(conflict => ({ lane: conflict.laneId, files: conflict.files })),
          targetConflicts: sync?.targetConflicts ?? [], behind: sync?.behind ?? 0,
          runningHeads: this.options.runningHeads?.(lane.id) ?? 0,
          ...(sync?.error ? { error: sync.error } : {}),
        };
      }),
    };
  }

  /** Window closing: stop every lane's terminal. Their records stay running, so the next start marks them "Hydra restarted". */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await Promise.all([...this.terminals.values()].map(terminal => terminal.kill().catch(() => undefined)));
  }

  // ---- internals ----

  private async launch(lane: Lane, resume: boolean, executable?: string): Promise<void> {
    const pty = this.options.pty;
    if (!pty) throw new Error(terminalsUnavailable);
    const testCommand = this.options.testCommand?.();
    executable ??= testCommand ? '' : await this.options.executable(lane.provider);
    const connected = testCommand ? true : await this.options.connected(lane.provider).catch(() => false);
    const prompt = !resume && lane.goal ? lanePreamble(lane, this.others(lane.id)) : undefined;
    const spec = laneLaunch({ lane, executable, resume, prompt, connected, bridge: this.options.bridge(lane.provider), mcpConfigFile: this.mcpConfigFile(lane.id), helpersDir: this.options.helpersDir, testCommand, env: this.options.env?.() ?? process.env });
    if (spec.mcpConfig) {
      await mkdir(this.options.configDirectory, { recursive: true });
      await writeFile(this.mcpConfigFile(lane.id), spec.mcpConfig, { encoding: 'utf8', mode: 0o600 });
    }
    // `.cmd` shims go through PowerShell -EncodedCommand, so arguments are never re-quoted by hand.
    const launched = processLaunch(spec.executable, spec.args);
    const size = this.sizes.get(lane.id) ?? defaultTerminalSize;
    const previous = this.terminals.get(lane.id);
    const handle = pty.spawn(launched.executable, launched.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: lane.worktree, env: spec.env });
    const terminal: LaneTerminal = new LaneTerminal(handle, {
      onData: data => this.options.onData?.(lane.id, data),
      onExit: code => { void this.exited(lane.id, terminal, code); },
      killTree: this.options.killTree,
      initialReplay: previous?.replay(),
    });
    this.terminals.set(lane.id, terminal);
    this.options.log?.(`[lanes] ${lane.id} started ${testCommand ? 'the test command' : lane.provider}${resume ? ' (resumed)' : ''} in ${lane.worktree}`);
  }

  /** Mark the lane running first, so an immediate exit is recorded; undo that if the launch fails. */
  private async relaunch(lane: Lane, resume: boolean): Promise<void> {
    if (!(await stat(lane.worktree).catch(() => undefined))?.isDirectory()) throw new Error(`The worktree of lane ${lane.name} is gone. Close the lane.`);
    await this.options.store.update(lane.id, { state: 'running', exitCode: undefined, reason: undefined });
    try { await this.launch(lane, resume); }
    catch (error) {
      await this.options.store.update(lane.id, { state: 'exited', reason: `Could not start: ${describe(error)}`.slice(0, 500) }).catch(() => undefined);
      this.changed();
      throw error;
    }
    this.changed(); this.schedule();
  }

  private async exited(id: string, terminal: LaneTerminal, code: number): Promise<void> {
    if (this.disposed || this.terminals.get(id) !== terminal) return;
    const lane = this.options.store.get(id);
    if (!lane || lane.state === 'closed') return;
    try { await this.options.store.update(id, lane.state === 'running' ? { state: 'exited', exitCode: code } : { exitCode: code }); }
    catch (error) { this.options.log?.(`[lanes] ${id}: ${describe(error)}`); }
    this.options.log?.(`[lanes] ${id} exited (code ${code})`);
    this.changed();
  }

  /** A start that failed after its worktree was made: remove the fresh worktree and branch, and forget the lane. */
  private async rollback(lane: Lane): Promise<void> {
    await this.terminals.get(lane.id)?.kill();
    this.terminals.delete(lane.id);
    try { await closeLaneWorktree(lane, 'delete', this.roots(lane), [lane.worktree]); }
    finally { await this.options.store.remove(lane.id); await rm(this.mcpConfigFile(lane.id), { force: true }).catch(() => undefined); }
  }

  /** Where lane worktrees may live: the configured root and the default sibling folder. */
  private roots(lane: Lane): string[] {
    return [...new Set([this.options.worktreeRoot(), defaultWorktreeRoot(lane.repository)].filter((root): root is string => !!root))];
  }

  private others(id: string): LanePreambleOther[] {
    return this.lanes().filter(other => other.id !== id && other.state !== 'merged')
      .map(other => ({ name: other.name, provider: other.provider, goal: other.goal, files: this.results.get(other.id)?.changedFiles ?? [] }));
  }

  private async runSync(): Promise<void> {
    const lanes = this.lanes();
    const results = lanes.length ? await this.syncer.run(lanes) : new Map<string, LaneSyncView>();
    if (this.disposed) return;
    const comparable = (map: Map<string, LaneSyncView>) => JSON.stringify([...map].map(([id, result]) => [id, { ...result, checkedAt: '' }]));
    const changed = comparable(results) !== comparable(this.results);
    this.results = results;
    if (changed) this.changed();
  }

  /** The coordination cadence runs only while a lane is open. */
  private schedule(): void {
    const wanted = !this.disposed && this.lanes().length > 0;
    if (wanted && !this.timer) {
      this.timer = setInterval(() => { void this.sync().catch(error => this.options.log?.(`[lanes] sync: ${describe(error)}`)); }, this.options.syncIntervalMs ?? syncIntervalMs);
      this.timer.unref?.();
    } else if (!wanted && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private afterGit(): void { this.changed(); void this.sync().catch(() => undefined); }

  /** One action per lane at a time, so a double click can't merge or close twice. */
  private async exclusive<T>(id: unknown, work: (lane: Lane) => Promise<T>): Promise<T> {
    const lane = this.openLane(id);
    if (this.busy.has(lane.id)) throw new Error(`Lane ${lane.name} is busy with another action. Try again in a moment.`);
    this.busy.add(lane.id);
    try { return await work(lane); } finally { this.busy.delete(lane.id); }
  }
  private openLane(id: unknown): Lane {
    if (!isLaneId(id)) throw new Error('Invalid lane ID.');
    const lane = this.options.store.get(id);
    if (!lane || lane.state === 'closed') throw new Error('That lane isn\'t open in this window.');
    return lane;
  }
  private mcpConfigFile(id: string): string { return path.join(this.options.configDirectory, `${id}.mcp.json`); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private changed(): void { if (!this.disposed) this.options.onChange?.(); }
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
