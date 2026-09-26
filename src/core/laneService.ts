import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { laneHasConversation, type LaneConversationOptions } from './laneResume';
import { git, gitMetaFingerprint, gitRun, type GitMetaFingerprint } from './git';
import { isWindowsShim, processLaunch, shimSafe } from './process';
import { RoleUnavailable, codexDeveloperInstructions, roleFirstPrompt, roleLaunch, type RoleLaunch, type RoleSource } from './packs/launch';
import { createWorktree, defaultWorktreeRoot } from './worktrees';
import { LaneTerminal, minCols, maxCols, minRows, maxRows, terminalText, terminalsUnavailable, type PtyModule } from './lanePty';
import { LaneSync, laneDiffBase, syncIntervalMs } from './laneSync';
import { checkMerge, closeLaneWorktree, commitLane, laneDirty, laneFullyMerged, mergeLane, pushLane, updateLane, type CloseMode, type MergeCheck } from './laneFinish';
import { isLaneId, isSafeBranchName, laneBranch, laneContinuePrompt, laneFolder, laneJobFolder, lanePreamble, laneRolePrompt, laneRoleRef, newLaneId, parseLaneInput, type Lane, type LaneGatesRecord, type LanePlanLink, type LanePreambleOther, type LanePromptRole, type LaneStore, type LaneSwitchReason } from './lanes';
import { otherProvider } from './limitEvents';
import { buildHandoff, defaultHandoffDeps, type HandoffDeps } from './limitHandoff';
import { freshDirectory, loadGates, runGates as runGatesCore, type GateContext, type GatesConfig, type GatesLoader, type GatesOutcome } from './gates';
import { gateBlocks, type JobCheckResult } from './jobs';
import type { HelperServerSpec } from './helperRegistration';
import type { LimitEvent } from './limitEvents';
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
  lane: Pick<Lane, 'id' | 'name' | 'branch' | 'provider'> & { plan?: LanePlanLink };
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
  /** Packs (docs/Packs_Plan.md, section 5): the lane's role for this launch (roleLaunch), passed every time: fresh, Resume, Start fresh and Switch. */
  role?: RoleLaunch;
}
export interface LaneLaunch { executable: string; args: string[]; env: Record<string, string>; mcpConfig?: string }

/** A TOML literal string. Lane values never contain a quote or line break; refuse rather than mis-quote. */
const toml = (value: string) => { if (value.includes("'") || /[\r\n]/.test(value)) throw new Error('A lane setting contains a quote or line break.'); return `'${value}'`; };

/** shimSafe lives with processLaunch now; lanes and tests still import it from here. */
export { shimSafe };

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

/** Markers a parent Claude Code session leaves in its children's environment; user settings (CLAUDE_CODE_USE_BEDROCK...) pass. */
const sessionMarkers = new Set(['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING']);
export function inheritedSessionVariable(key: string): boolean { return sessionMarkers.has(key.toUpperCase()); }

/**
 * The command line and environment of a lane's CLI. The environment is the
 * host's plus the lane's identity (HYDRA_LANE_ID, its name and branch, for the
 * bridge), HYDRA_LEAD_PROVIDER, HYDRA_HELPERS_DIR and a colour terminal.
 */
export function laneLaunch(input: LaneLaunchInput): LaneLaunch {
  const { lane } = input;
  // HYDRA_LANE_HELPERS_DIR names this window even when the user-level server's own
  // HYDRA_HELPERS_DIR (which wins over ours) belongs to another Hydra profile.
  const laneEnv: Record<string, string> = { HYDRA_LANE_ID: lane.id, HYDRA_LANE_NAME: lane.name, HYDRA_LANE_BRANCH: lane.branch, HYDRA_LANE_HELPERS_DIR: input.helpersDir };
  // A plan lane's bridge offers hydra_job_ready and says so in its instructions (docs/Plan_Lanes_Plan.md, decision 6).
  if (lane.plan) laneEnv.HYDRA_LANE_PLAN_JOB = '1';
  const env: Record<string, string> = {};
  // The host may run as Node, or have been started from inside a Claude Code session;
  // a lane is a fresh top-level session, so neither reaches it.
  for (const [key, value] of Object.entries(input.env)) if (typeof value === 'string' && !inheritedSessionVariable(key)) env[key] = value;
  // A role's Codex servers read some variables by name (R4); roleLaunch never sets one of Hydra's or the CLI's own.
  Object.assign(env, input.role?.env);
  // Like heads, a lane never updates the user's CLI behind their back.
  Object.assign(env, laneEnv, { HYDRA_LEAD_PROVIDER: lane.provider, HYDRA_HELPERS_DIR: input.helpersDir, TERM: 'xterm-256color', COLORTERM: 'truecolor', DISABLE_AUTOUPDATER: '1' });
  if (input.testCommand) return { ...parseTestCommand(input.testCommand), env };
  const shim = isWindowsShim(input.executable, input.platform ?? process.platform);
  const prompt = input.prompt && !input.resume ? (shim ? shimSafe(input.prompt) : input.prompt) : undefined;
  const role = input.role;
  // The bridge reads the lane from its environment. Claude passes its own environment
  // on to the servers it starts; Codex doesn't, so the lane's values go into its server config.
  const serverEnv = { ...input.bridge.env, ...laneEnv };
  if (lane.provider === 'claude') {
    // A role's servers go in the lane's own 0600 file even when Claude is connected (its user-level
    // Hydra entry then serves the lane), with `${NAME}` references Claude fills in itself (R3).
    const roleServers = role?.mcpServers ?? {};
    const file = !input.connected || Object.keys(roleServers).length > 0;
    const mcp = file ? ['--mcp-config', input.mcpConfigFile] : [];
    const hydra = input.connected ? {} : { hydra: { type: 'stdio', command: input.bridge.command, args: input.bridge.args, env: serverEnv, timeout: 3_600_000 } };
    const mcpConfig = file ? JSON.stringify({ mcpServers: { ...hydra, ...roleServers } }, null, 2) : undefined;
    // The role's instructions file and skills on every launch: Resume keeps the system prompt the conversation started with (R1).
    const roleArgs = role ? [...(role.systemPromptFile ? ['--append-system-prompt-file', role.systemPromptFile] : []), ...(role.pluginDir ? ['--plugin-dir', role.pluginDir] : []), ...(role.model ? ['--model', role.model] : [])] : [];
    return { executable: input.executable, args: input.resume ? ['--continue', ...roleArgs, ...mcp] : [...roleArgs, ...mcp, ...(prompt ? [prompt] : [])], env, ...(mcpConfig ? { mcpConfig } : {}) };
  }
  const config = (key: string, value: string) => ['-c', `mcp_servers.hydra.${key}=${value}`];
  const overrides = input.connected
    ? Object.entries(laneEnv).flatMap(([key, value]) => config(`env.${key}`, toml(value)))
    : [
      ...config('command', toml(input.bridge.command)), ...config('args', `[${input.bridge.args.map(toml).join(', ')}]`),
      ...config('env', `{ ${Object.entries(serverEnv).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`),
      ...config('startup_timeout_sec', '30'), ...config('tool_timeout_sec', '3600'), ...config('default_tools_approval_mode', '\'approve\''),
    ];
  // A role's servers on every launch (they are this process's config); its instructions and model only on a
  // fresh thread, which keeps them on resume (R2). Text that can't pass as one TOML literal goes in the first prompt instead.
  const developer = role && !input.resume ? codexDeveloperInstructions(role.text, shim) : undefined;
  const roleConfig = [...role?.codexConfig ?? [], ...(developer ? ['-c', `developer_instructions='${developer}'`] : []), ...(role?.model && !input.resume ? ['-m', role.model] : [])];
  return { executable: input.executable, args: input.resume ? [...overrides, ...roleConfig, 'resume', '--last'] : [...overrides, ...roleConfig, ...(prompt ? [prompt] : [])], env };
}

/**
 * Whether a Codex lane's role goes in its first prompt (docs/Packs_Plan.md, section 5):
 * on a fresh thread, when its text can't pass as developer instructions.
 */
export const codexRoleInPrompt = (role: RoleLaunch, provider: Provider, resume: boolean, shim: boolean): boolean =>
  provider === 'codex' && !resume && codexDeveloperInstructions(role.text, shim) === undefined;

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
  /** For building the "Continue in <Other>" / manual-switch handoff. Defaults to the real filesystem and git. */
  handoffDeps?: HandoffDeps;
  // ---- Gates (docs/Gates_Plan.md, "Lanes"): Run gates, and Merge when gates.json says "onMerge" ----
  /** The provider CLI, version-checked, for a review gate. Undefined: gates are refused with a plain reason. */
  gatesExecutable?: (provider: Provider) => Promise<string>;
  /** A provider that is at its usage limit now; a review then uses the other one. */
  gatesLimited?: (provider: Provider) => boolean;
  /** Where lane gate runs keep their logs and screenshots, one fresh subfolder per run. */
  gatesLogDirectory?: string;
  /** Test seam: replaces runGates entirely (fake results, no real process/browser work). */
  gatesRuntime?: GateContext['runtime'];
  // ---- Plan lanes (docs/Plan_Lanes_Plan.md) ----
  /** The plan job a lane runs, for the hydra_lanes answer: its plan, its job and how many jobs wait on it. */
  planOf?: (laneId: string) => { title: string; job: string; dependents: number } | undefined;
  // ---- Packs (docs/Packs_Plan.md) ----
  /** Where the repository's gates come from: gates.json plus the active packs' gates (PackService.gates). Defaults to gates.json only. */
  gates?: GatesLoader;
  /** The active packs' roles (PackService). Without it, a lane's role is never available and its tile says so. */
  roles?: RoleSource;
  /**
   * Resume when the CLI never began a conversation (docs/Heads.md, "Restarting Hydra"): where
   * `laneHasConversation` looks. Defaults to the real home, this window's env and platform. Tests
   * override `home` with a temp fake home, never the real `~/.claude` or `~/.codex`.
   */
  conversation?: { home?: () => string; platform?: NodeJS.Platform; fs?: LaneConversationOptions['fs'] };
}

/** How a plan lane starts (docs/Plan_Lanes_Plan.md, "Starting a lane job"). */
export interface LaneCreateOptions {
  /** A full commit id to branch from: the work of the jobs it depends on. Missing: the main checkout's HEAD. */
  baseCommit?: string;
  /** The plan job the lane runs. */
  plan?: LanePlanLink;
  /** The job's full brief, written to .hydra-job/brief.md in the worktree (decision 2). */
  brief?: string;
}
/** What Mark job done hands on, or why it can't (docs/Plan_Lanes_Plan.md, "What done means for a lane job"). */
export type LaneHandOn =
  | { ok: true; commit: string; base: string; changedFiles: string[]; subjects: string[] }
  | { ok: false; reason: 'dirty' | 'nothing'; message: string };

/** A fingerprint of a gates file's contents: a passing run is reused only while this is unchanged. */
export function gatesFingerprint(config: Pick<GatesConfig, 'source' | 'gates' | 'maxAttempts'> & { notRun?: JobCheckResult[] }): string {
  // Packs: a listed pack that can't run changes what a run means, so its not-run gates count too.
  const notRun = config.notRun?.length ? { notRun: config.notRun.map(result => result.id) } : {};
  return createHash('sha256').update(JSON.stringify({ source: config.source, maxAttempts: config.maxAttempts ?? null, gates: config.gates, ...notRun })).digest('hex').slice(0, 16);
}

/** The confirmation's note for gates that didn't fail. Packs (docs/Packs_Plan.md): a gate that didn't run is named, never counted as passed. */
export function gatesPassNote(results: readonly JobCheckResult[], when = ''): string {
  const skipped = results.filter(result => result.state === 'notRun').map(result => result.id);
  if (!skipped.length) return ` Gates passed${when}.`;
  return skipped.length === results.length ? ` Gates not run: ${skipped.join(', ')}.` : ` Gates passed${when}; not run: ${skipped.join(', ')}.`;
}

/**
 * Write a plan lane's full brief into its fresh worktree, in a folder whose own .gitignore
 * ignores everything, so git never sees it and no commit can include it. A worktree that
 * already has that path (tracked, or a link) is refused rather than written through.
 */
export async function writeLaneJobBrief(worktree: string, text: string): Promise<string> {
  const folder = path.join(worktree, laneJobFolder);
  if (await lstat(folder).then(() => true, () => false)) throw new Error(`The repository already has a ${laneJobFolder} folder, so Hydra can't write the job's brief there.`);
  await mkdir(folder);
  await writeFile(path.join(folder, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'wx' });
  const file = path.join(folder, 'brief.md');
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
  return file;
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
  /** A gates run in progress per lane (docs/Gates_Plan.md, "Cancel"): closing the lane or starting a new run cancels it. */
  private readonly gateRuns = new Map<string, AbortController>();
  /** Packs: why a lane's role wasn't available at its last launch, for its tile: "Role Reviewer isn't available: the Coding pack is off." */
  private readonly roleNotes = new Map<string, string>();
  /** Item 1 (docs/Heads.md, "Restarting Hydra"): set when a Resume found no earlier conversation and started fresh instead. Cleared at the lane's next launch. */
  private readonly resumeNotes = new Map<string, string>();
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
      const sync = this.results.get(lane.id), roleNote = this.roleNotes.get(lane.id), resumeNote = this.resumeNotes.get(lane.id);
      return { ...lane, ...(sync ? { sync: structuredClone(sync) } : {}), running: !!this.terminals.get(lane.id)?.running, ...(roleNote ? { roleNote } : {}), ...(resumeNote ? { resumeNote } : {}) };
    });
  }

  /** Start a lane: a worktree and branch from the main checkout's HEAD (or a plan job's base commit), and its CLI in a terminal. */
  async create(value: unknown, options: LaneCreateOptions = {}): Promise<Lane> {
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
    const created = await createWorktree(this.options.repository, input.name, id, this.options.worktreeRoot(), options.baseCommit, { branch: laneBranch(input.name, id), folder: laneFolder(id) });
    // 1.4 (docs/Hydra_Improvements.md): best effort, like a head's equivalent snapshot — a repository
    // Hydra can't fingerprint (a very unusual .git layout) simply gets no git-metadata check later.
    const gitMeta: GitMetaFingerprint | undefined = await gitMetaFingerprint(created.worktree).catch(() => undefined);
    const lane: Lane = {
      id, name: input.name, provider: input.provider, ...(input.goal ? { goal: input.goal } : {}), ...(input.role ? { role: input.role } : {}),
      repository: this.options.repository, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit,
      target: isSafeBranchName(created.integrationTarget) ? created.integrationTarget : current,
      createdAt: this.now().toISOString(), state: 'running',
      ...(options.plan ? { plan: options.plan } : {}),
      ...(gitMeta ? { gitMeta } : {}),
    };
    this.busy.add(id);
    try {
      await this.options.store.add(lane);
      if (options.brief !== undefined) await writeLaneJobBrief(lane.worktree, options.brief);
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

  /**
   * Continue the lane's last conversation in a new terminal. Item 1 (docs/Heads.md, "Restarting
   * Hydra"): first checks whether the CLI actually began one in this worktree. Without one,
   * Resume would open an empty session and lose the lane's goal, so this starts fresh instead
   * (the same launch as Start fresh) and leaves a short note on the tile. Lanes started by
   * HYDRA_TEST_LANE_COMMAND keep today's behaviour, since nothing real ever wrote a conversation.
   */
  async resume(id: unknown): Promise<void> {
    await this.exclusive(id, async lane => {
      if (this.terminals.get(lane.id)?.running) throw new Error(`Lane ${lane.name} is already running.`);
      if (this.options.testCommand?.()) { await this.relaunch(lane, true); return; }
      const has = await laneHasConversation(lane.provider, lane.worktree, new Date(lane.createdAt), this.conversationOptions()).catch(() => true);
      await this.relaunch(lane, has);
      if (!has) { this.resumeNotes.set(lane.id, 'No earlier conversation to resume, so the lane started fresh.'); this.changed(); }
    });
  }

  /** Start fresh: stop the lane's CLI if it runs, then start a new conversation (with the goal's first prompt). */
  async restart(id: unknown): Promise<void> {
    await this.exclusive(id, async lane => {
      await this.terminals.get(lane.id)?.kill();
      await this.relaunch(this.options.store.get(lane.id)!, false);
    });
  }

  /**
   * "Continue in <Other>" after a usage limit, or the manual "Switch to <Other>"
   * (docs/Gates_Plan.md, section 2): build the handoff, end the lane's session,
   * switch `lane.provider` and record the switch, then relaunch the other CLI in
   * the same worktree and branch, with the lane preamble plus the handoff as its
   * first prompt. Uncommitted work is untouched — the switch never touches git.
   */
  async switchProvider(id: unknown, reason: LaneSwitchReason, event?: LimitEvent): Promise<Lane> {
    return this.exclusive(id, async lane => {
      const to = otherProvider(lane.provider);
      const limitEvent: LimitEvent = event ?? { provider: lane.provider, source: 'lane', laneId: lane.id, at: this.now().toISOString(), cwd: lane.worktree };
      const handoff = await buildHandoff({ event: limitEvent }, this.options.handoffDeps ?? defaultHandoffDeps(this.options.env?.() ?? process.env));
      await this.terminals.get(lane.id)?.kill();
      const switches = [...(lane.switches ?? []), { from: lane.provider, to, at: this.now().toISOString(), reason }];
      const updated = await this.options.store.update(lane.id, { provider: to, switches, state: 'running', exitCode: undefined, exitedAt: undefined, reason: undefined });
      try { await this.launch(updated, false, undefined, { from: lane.provider, markdown: handoff.markdown }); }
      catch (error) {
        await this.options.store.update(lane.id, { state: 'exited', exitedAt: this.now().toISOString(), reason: `Could not start: ${describe(error)}`.slice(0, 500) }).catch(() => undefined);
        this.changed();
        throw error;
      }
      this.changed(); this.schedule();
      return this.options.store.get(lane.id)!;
    });
  }

  /** Keys typed in the lane's tile. Ignored when its terminal isn't running. */
  input(id: unknown, data: string): boolean {
    const terminal = isLaneId(id) ? this.terminals.get(id) : undefined;
    if (!terminal?.running) return false;
    terminal.write(data);
    return true;
  }

  /**
   * 1.3 (docs/Hydra_Improvements.md): Hydra's own text into a lane, never the user's keystrokes
   * (those go through `input` unchanged, since arrow keys and the like are escape sequences on
   * purpose). Used for "Send to lane" and anywhere else Hydra types text it didn't write itself,
   * such as a gate's command output, into a lane's terminal.
   */
  typeText(id: unknown, text: string): boolean { return this.input(id, terminalText(text)); }

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
      // The lane HEAD it merged (the merge commit's second parent): a plan job done by merging hands this on.
      const mergedHead = (await gitRun(lane.repository, ['rev-parse', '--verify', '--quiet', `${commit}^2`])).stdout.trim();
      await this.options.store.update(lane.id, { state: 'merged', mergedAt: this.now().toISOString(), ...(/^[a-f0-9]{40,64}$/.test(mergedHead) ? { mergedHead } : {}) });
      this.options.log?.(`[lanes] ${lane.id} merged into ${lane.target} (${commit.slice(0, 12)})`);
      this.afterGit();
      return commit;
    });
  }
  async update(id: unknown): Promise<{ conflicts: string[]; upToDate: boolean }> {
    return this.exclusive(id, async lane => { const result = await updateLane(lane); this.afterGit(); return result; });
  }
  async push(id: unknown): Promise<{ branch: string; compareUrl?: string }> { return this.exclusive(id, lane => pushLane(lane)); }

  /**
   * Run this project's gates against the lane's worktree (docs/Gates_Plan.md,
   * "Lanes"): "⋯ → Run gates" at any time, or Merge when gates.json says
   * "onMerge". The lane need not be committed — gates run on whatever is on
   * disk now, since a command or review gate reads the worktree directly; the
   * caller (extensionLanes.ts) tells the user when that's uncommitted work, not
   * this method. Runs outside `exclusive` so input/diff/etc. stay usable while
   * it works; a new call or `cancelGates` aborts a run already in progress.
   */
  async runGates(id: unknown, onProgress?: (progress: { done: JobCheckResult[]; running?: string }) => void): Promise<GatesOutcome> {
    const lane = this.openLane(id);
    if (!this.options.gatesExecutable) throw new Error('Gates need Hydra heads to be ready in this window yet.');
    this.cancelGates(lane.id);
    const controller = new AbortController();
    this.gateRuns.set(lane.id, controller);
    try {
      const head = (await gitRun(lane.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      // Plan lanes: measured from laneDiffBase, and the commit is recorded when the lane was clean, so Merge can reuse the run.
      const cleanBefore = !await laneDirty(lane).catch(() => true);
      const base = await laneDiffBase(lane, head);
      const config = await (this.options.gates ?? loadGates)(lane.repository).catch(() => undefined);
      const logDirectory = await freshDirectory(this.options.gatesLogDirectory ?? path.join(this.options.configDirectory, '..', 'gates'), `${lane.id}-${Date.now()}`);
      const outcome = await runGatesCore(lane.repository, lane.worktree, base, {
        author: lane.provider, title: lane.name, brief: lane.goal, logDirectory,
        executable: this.options.gatesExecutable,
        ...(this.options.gatesLimited ? { limited: this.options.gatesLimited } : {}),
        signal: controller.signal, ...(onProgress ? { onProgress } : {}), ...(this.options.log ? { log: this.options.log } : {}),
        ...(this.options.gatesRuntime ? { runtime: this.options.gatesRuntime } : {}),
      }, this.options.gates);
      if (controller.signal.aborted) throw new Error('The gates run was cancelled.');
      const headAfter = (await gitRun(lane.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
      const commit = cleanBefore && headAfter === head && /^[a-f0-9]{40,64}$/.test(head) && !await laneDirty(lane).catch(() => true) ? head : undefined;
      await this.options.store.update(lane.id, { lastGates: { source: outcome.source, at: this.now().toISOString(), results: outcome.results, ...(commit ? { commit } : {}), ...(config ? { config: gatesFingerprint(config) } : {}) } });
      this.changed();
      return outcome;
    } finally {
      if (this.gateRuns.get(lane.id) === controller) this.gateRuns.delete(lane.id);
    }
  }
  /**
   * A passing gates run Merge (or Mark job done) can reuse instead of running the gates again
   * (docs/Plan_Lanes_Plan.md, section 3): recorded on the lane's current HEAD, with the lane
   * clean now and the gates file unchanged since. Undefined when there is none.
   */
  async reusableGates(id: unknown): Promise<LaneGatesRecord | undefined> {
    const lane = this.openLane(id);
    const record = lane.lastGates;
    if (!record?.commit || !record.config || record.results.some(gateBlocks)) return undefined;
    const head = (await gitRun(lane.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== record.commit || await laneDirty(lane).catch(() => true)) return undefined;
    const config = await (this.options.gates ?? loadGates)(lane.repository).catch(() => undefined);
    return config && gatesFingerprint(config) === record.config ? record : undefined;
  }

  // ---- Plan lanes (docs/Plan_Lanes_Plan.md) ----

  /**
   * What Mark job done hands on: the lane's HEAD, the files it changed since laneDiffBase and its
   * commit subjects (at most 10). Refused with the reason when the lane has uncommitted changes
   * (untracked files included) or nothing beyond its base.
   */
  async handOn(id: unknown): Promise<LaneHandOn> {
    return this.exclusive(id, async lane => {
      const head = (await git(lane.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if (await laneDirty(lane)) return { ok: false, reason: 'dirty', message: `Lane ${lane.name} has uncommitted changes. Commit them first.` };
      const base = await laneDiffBase(lane, head);
      const changedFiles = head === lane.baseCommit ? [] : (await git(lane.repository, ['diff', '--name-only', '-z', '--no-renames', base, head, '--'])).split('\0').filter(Boolean);
      if (!changedFiles.length) return { ok: false, reason: 'nothing', message: 'Nothing to hand on yet.' };
      const subjects = (await git(lane.repository, ['log', '--format=%s', '-n', '10', `${base}..${head}`])).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      return { ok: true, commit: head, base, changedFiles: changedFiles.slice(0, 300), subjects };
    });
  }
  /** Cancel job: the lane stays open as an ordinary lane, without its plan link. */
  async unlinkPlan(id: unknown): Promise<void> {
    const lane = this.openLane(id);
    if (!lane.plan) return;
    await this.options.store.update(lane.id, { plan: undefined });
    this.changed();
  }
  /** A lane's record, closed or not, while the store keeps it: a plan reads how its lane ended. */
  record(id: string): Lane | undefined { return isLaneId(id) ? this.options.store.get(id) : undefined; }

  /**
   * Packs (docs/Packs_Plan.md, "Not done"): the active roles changed while a lane may still be
   * running. A **running** lane whose role is no longer active gets a note right away, instead of
   * waiting for its next launch; a running lane whose role became active again has the note
   * cleared. An exited lane is untouched — it still gets the ordinary note (`laneRole`, above) at
   * its next Resume or Start fresh.
   */
  async activeRolesChanged(): Promise<void> {
    if (!this.options.roles) return;
    let changed = false;
    for (const lane of this.lanes()) {
      if (!lane.role || !this.terminals.get(lane.id)?.running) continue;
      const ref = laneRoleRef(lane.role);
      try {
        await this.options.roles.resolve(lane.repository, ref);
        if (this.roleNotes.delete(lane.id)) changed = true;
      } catch (error) {
        const title = error instanceof RoleUnavailable ? error.title : lane.role.role;
        const reason = error instanceof RoleUnavailable ? error.reason : describe(error);
        const note = `Role ${title} isn't available now: ${reason}. This session keeps it until you Start fresh.`.slice(0, 300);
        if (this.roleNotes.get(lane.id) !== note) { this.roleNotes.set(lane.id, note); changed = true; }
      }
    }
    if (changed) this.changed();
  }

  /** Cancel a gates run in progress on this lane, if any: closing the lane, or a fresh Run gates/Merge. */
  cancelGates(id: unknown): void {
    const key = typeof id === 'string' ? id : '';
    const controller = this.gateRuns.get(key);
    if (!controller) return;
    controller.abort();
    this.gateRuns.delete(key);
  }
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
      this.cancelGates(lane.id);
      await this.terminals.get(lane.id)?.kill();
      const result = await closeLaneWorktree(lane, mode, this.roots(lane), this.lanes().map(open => open.worktree));
      await rm(this.mcpConfigFile(lane.id), { force: true }).catch(() => undefined);
      await this.options.store.update(lane.id, { state: 'closed', closedAs: mode });
      this.terminals.delete(lane.id); this.sizes.delete(lane.id); this.results.delete(lane.id); this.roleNotes.delete(lane.id); this.resumeNotes.delete(lane.id);
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
          // Packs (docs/Packs_Plan.md, "Lanes"): each lane's role, and why it isn't available when it wasn't at its last start.
          ...(lane.role ? { role: laneRoleRef(lane.role), ...(this.roleNotes.has(lane.id) ? { roleNote: this.roleNotes.get(lane.id) } : {}) } : {}),
          // Plan lanes (docs/Plan_Lanes_Plan.md, section 5): other lanes' agents see which plan job a lane runs.
          ...this.planOf(lane.id),
        };
      }),
    };
  }

  /** Window closing: stop every lane's terminal. Their records stay running, so the next start marks them "Hydra restarted". */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const controller of this.gateRuns.values()) controller.abort();
    this.gateRuns.clear();
    await Promise.all([...this.terminals.values()].map(terminal => terminal.kill().catch(() => undefined)));
  }

  // ---- internals ----

  /**
   * Start the lane's CLI. `handoff` is a provider switch's (docs/Gates_Plan.md, section 2): the first
   * prompt is then the preamble plus the handoff. The lane's role is resolved again every time.
   */
  private async launch(lane: Lane, resume: boolean, executable?: string, handoff?: { from: Provider; markdown: string }): Promise<void> {
    this.resumeNotes.delete(lane.id);
    const pty = this.options.pty;
    if (!pty) throw new Error(terminalsUnavailable);
    const testCommand = this.options.testCommand?.();
    executable ??= testCommand ? '' : await this.options.executable(lane.provider);
    const connected = testCommand ? true : await this.options.connected(lane.provider).catch(() => false);
    const env = this.options.env?.() ?? process.env;
    const role = await this.laneRole(lane, executable, env);
    // A Codex lane whose role can't pass as developer instructions gets it in the first prompt; with no goal,
    // the role and then "Wait for the user's first request." (docs/Packs_Plan.md, section 5).
    const inPrompt = role && codexRoleInPrompt(role, lane.provider, resume, isWindowsShim(executable));
    const promptRole: LanePromptRole | undefined = role && { label: role.label, ...(inPrompt ? { text: (max: number) => roleFirstPrompt(role, max) } : {}) };
    const withRole = { ...lane, ...(promptRole ? { promptRole } : {}) };
    const prompt = handoff ? laneContinuePrompt(withRole, handoff.from, this.others(lane.id), handoff.markdown)
      : resume ? undefined
      : lane.goal ? lanePreamble(withRole, this.others(lane.id))
      : promptRole?.text ? laneRolePrompt({ label: promptRole.label, text: promptRole.text }) : undefined;
    const spec = laneLaunch({ lane, executable, resume, prompt, connected, bridge: this.options.bridge(lane.provider), mcpConfigFile: this.mcpConfigFile(lane.id), helpersDir: this.options.helpersDir, testCommand, env, ...(role ? { role } : {}) });
    if (spec.mcpConfig) {
      await mkdir(this.options.configDirectory, { recursive: true });
      await writeFile(this.mcpConfigFile(lane.id), spec.mcpConfig, { encoding: 'utf8', mode: 0o600 });
    } else await rm(this.mcpConfigFile(lane.id), { force: true }).catch(() => undefined);
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

  /**
   * The lane's role for this launch (docs/Packs_Plan.md, "Lanes"), from its pack's checked copy. When
   * it is gone (the pack is off, changed or uninstalled) the lane starts without it, and its tile says why.
   */
  private async laneRole(lane: Lane, executable: string, env: NodeJS.ProcessEnv): Promise<RoleLaunch | undefined> {
    if (!lane.role) { this.roleNotes.delete(lane.id); return undefined; }
    const ref = laneRoleRef(lane.role);
    try {
      if (!this.options.roles) throw new RoleUnavailable(ref, lane.role.role, 'packs aren\'t available in this Hydra window');
      const resolved = await this.options.roles.resolve(lane.repository, ref);
      const role = roleLaunch(resolved, { provider: lane.provider, target: 'lane', env, shim: isWindowsShim(executable) });
      this.roleNotes.delete(lane.id);
      if (role.notes.length) this.options.log?.(`[lanes] ${lane.id}: ${role.notes.join(' ')}`);
      return role;
    } catch (error) {
      const note = error instanceof RoleUnavailable ? error.laneNote : `Role ${lane.role.role} isn't available: ${describe(error)}`;
      this.roleNotes.set(lane.id, note.slice(0, 300));
      this.options.log?.(`[lanes] ${lane.id}: ${note}`);
      return undefined;
    }
  }

  /** Mark the lane running first, so an immediate exit is recorded; undo that if the launch fails. */
  private async relaunch(lane: Lane, resume: boolean): Promise<void> {
    if (!(await stat(lane.worktree).catch(() => undefined))?.isDirectory()) throw new Error(`The worktree of lane ${lane.name} is gone. Close the lane.`);
    await this.options.store.update(lane.id, { state: 'running', exitCode: undefined, exitedAt: undefined, reason: undefined });
    try { await this.launch(lane, resume); }
    catch (error) {
      await this.options.store.update(lane.id, { state: 'exited', exitedAt: this.now().toISOString(), reason: `Could not start: ${describe(error)}`.slice(0, 500) }).catch(() => undefined);
      this.changed();
      throw error;
    }
    this.changed(); this.schedule();
  }

  private async exited(id: string, terminal: LaneTerminal, code: number): Promise<void> {
    if (this.disposed || this.terminals.get(id) !== terminal) return;
    const lane = this.options.store.get(id);
    if (!lane || lane.state === 'closed') return;
    try { await this.options.store.update(id, lane.state === 'running' ? { state: 'exited', exitCode: code, exitedAt: this.now().toISOString() } : { exitCode: code }); }
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
  /** Item 1: laneHasConversation's environment. Tests override `conversation.home` with a temp fake home. */
  private conversationOptions(): LaneConversationOptions {
    const conversation = this.options.conversation;
    return {
      home: conversation?.home?.() ?? homedir(),
      env: this.options.env?.() ?? process.env,
      platform: conversation?.platform ?? process.platform,
      ...(conversation?.fs ? { fs: conversation.fs } : {}),
    };
  }
  private planOf(id: string): { plan?: { title: string; job: string; dependents: number } } { const plan = this.options.planOf?.(id); return plan ? { plan } : {}; }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private changed(): void { if (!this.disposed) this.options.onChange?.(); }
}

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
