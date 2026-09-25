import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';
import type { JobCheckResult } from './jobs';

/**
 * Hydra lanes (docs/Lanes_And_Planner_Plan.md, section 1). A lane is a git
 * worktree and branch with an interactive `claude` or `codex` running in a real
 * terminal, driven by you rather than by a lead. This module is the record: its
 * validation, the per-window store, the restart transition and the first prompt.
 */
export type LaneState = 'running' | 'exited' | 'merged' | 'closed';
export const laneStates: readonly LaneState[] = ['running', 'exited', 'merged', 'closed'];
export interface Lane {
  id: string;
  name: string;
  provider: Provider;
  goal?: string;
  /** The main checkout's root. */
  repository: string;
  worktree: string; branch: string; baseCommit: string;
  /** The branch the main checkout was on when the lane started: where it merges. */
  target: string;
  createdAt: string;
  state: LaneState;
  exitCode?: number; mergedAt?: string;
  /** Why Hydra stopped the lane's terminal, when it did (for example "Hydra restarted"). */
  reason?: string;
  /** Provider switches this lane has made (docs/Gates_Plan.md, section 2: "Continue in <Other>" and the manual "Switch to <Other>"). Oldest first. */
  switches?: LaneSwitch[];
  /** The last gates run on this lane (docs/Gates_Plan.md, "Lanes"): Run gates, or Merge when gates.json says "onMerge". Kept for the tile's chips and View evidence; only the most recent run. */
  lastGates?: LaneGatesRecord;
}

export interface LaneGatesRecord {
  /** Where the gates came from (GatesConfig['source']): 'gates' | 'checks' | 'none'. */
  source: 'gates' | 'checks' | 'none';
  at: string;
  results: JobCheckResult[];
}

export type LaneSwitchReason = 'limit' | 'manual';
export interface LaneSwitch { from: Provider; to: Provider; at: string; reason: LaneSwitchReason }
export const laneSwitchReasons: readonly LaneSwitchReason[] = ['limit', 'manual'];
const maxLaneSwitches = 50;

/**
 * The only allowed state changes. A merged lane keeps its state when its
 * terminal exits; resuming any lane makes it running again.
 */
export const laneTransitions: Readonly<Record<LaneState, readonly LaneState[]>> = {
  running: ['exited', 'merged', 'closed'],
  exited: ['running', 'merged', 'closed'],
  merged: ['running', 'closed'],
  closed: [],
};
export const canLaneTransition = (from: LaneState, to: LaneState): boolean => from === to || laneTransitions[from].includes(to);

export const laneIdPattern = /^[a-f0-9]{12}$/;
export const isLaneId = (value: unknown): value is string => typeof value === 'string' && laneIdPattern.test(value);
export const laneNameMax = 40;
export const laneGoalMax = 2000;
/**
 * Lane names reach a branch name (slugged), the lane's environment and, for
 * Codex, a `-c` override on its command line, so they are kept to characters
 * that no shell or TOML string treats specially.
 */
const laneNamePattern = /^[\p{L}\p{N} _.()#-]+$/u;
export const laneNameRule = 'A lane name can use letters, numbers, spaces and - _ . ( ) #, up to 40 characters.';

export interface LaneInput { name: string; provider: Provider; goal?: string }

export function parseLaneName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Give the lane a name.');
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Give the lane a name.');
  if (name.length > laneNameMax || !laneNamePattern.test(name)) throw new Error(laneNameRule);
  return name;
}
export function parseLaneGoal(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('The goal must be text.');
  const goal = value.trim();
  if (goal.length > laneGoalMax) throw new Error(`The goal must be at most ${laneGoalMax} characters.`);
  return goal || undefined;
}
/** What a New lane form or command asked for. Everything is untrusted. */
export function parseLaneInput(value: unknown): LaneInput {
  if (!value || typeof value !== 'object') throw new Error('Lane input must be an object.');
  const source = value as Record<string, unknown>;
  if (source.provider !== 'claude' && source.provider !== 'codex') throw new Error('Choose Claude Code or Codex for the lane.');
  const goal = parseLaneGoal(source.goal);
  return { name: parseLaneName(source.name), provider: source.provider, ...(goal ? { goal } : {}) };
}

export const newLaneId = (): string => randomBytes(6).toString('hex');
/** The branch-safe part of a lane name: lowercase letters, digits and dashes, never empty. */
export function laneSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return slug || 'lane';
}
/** Branch names are built only from the slug and the id, never from raw input. */
export const laneBranch = (name: string, id: string): string => `lane/${laneSlug(name)}-${id}`;
export const laneFolder = (id: string): string => `lane-${id}`;
export const isLaneBranch = (branch: unknown, id: string): branch is string =>
  typeof branch === 'string' && laneIdPattern.test(id) && new RegExp(`^lane/[a-z0-9]+(?:-[a-z0-9]+)*-${id}$`).test(branch) && branch.length <= 5 + 32 + 1 + 12;
/**
 * A target branch Hydra will pass to git: a plain branch name that can't be read
 * as an option or a revision expression.
 */
export function isSafeBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 200) return false;
  if (!/^[A-Za-z0-9._/+@-]+$/.test(value) || value.startsWith('-') || value.includes('@{') || value === '@') return false;
  const parts = value.split('/');
  return parts.every(part => part && !part.startsWith('.') && !part.endsWith('.lock')) && !value.endsWith('.') && !value.includes('..');
}
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** A stored lane, checked field by field. Throws on anything malformed. */
export function validateLane(value: unknown): Lane {
  const lane = value as Partial<Lane> | undefined;
  if (!lane || typeof lane !== 'object') throw new Error('A stored lane is malformed.');
  const text = (field: unknown, max = 4096) => typeof field === 'string' && field.length > 0 && field.length <= max && !field.includes('\0');
  if (!isLaneId(lane.id)) throw new Error('A stored lane has an invalid id.');
  const where = `Stored lane ${lane.id}`;
  const name = parseLaneName(lane.name);
  if (lane.provider !== 'claude' && lane.provider !== 'codex') throw new Error(`${where} has an unknown provider.`);
  const goal = parseLaneGoal(lane.goal);
  if (!text(lane.repository) || !path.isAbsolute(lane.repository!) || !text(lane.worktree) || !path.isAbsolute(lane.worktree!)) throw new Error(`${where} has an invalid path.`);
  if (path.basename(lane.worktree!) !== laneFolder(lane.id)) throw new Error(`${where} has a worktree Hydra didn't make.`);
  if (!isLaneBranch(lane.branch, lane.id)) throw new Error(`${where} has an invalid branch.`);
  if (typeof lane.baseCommit !== 'string' || !fullSha.test(lane.baseCommit)) throw new Error(`${where} has an invalid base commit.`);
  if (!isSafeBranchName(lane.target)) throw new Error(`${where} has an invalid target branch.`);
  if (!text(lane.createdAt, 64) || !laneStates.includes(lane.state as LaneState)) throw new Error(`${where} is malformed.`);
  if (lane.exitCode !== undefined && !Number.isInteger(lane.exitCode)) throw new Error(`${where} has an invalid exit code.`);
  if (lane.mergedAt !== undefined && !text(lane.mergedAt, 64)) throw new Error(`${where} has an invalid merge time.`);
  if (lane.reason !== undefined && !text(lane.reason, 500)) throw new Error(`${where} has an invalid reason.`);
  const switches = validateLaneSwitches(lane.switches, where);
  const lastGates = validateLastGates(lane.lastGates, where);
  return {
    id: lane.id, name, provider: lane.provider, ...(goal ? { goal } : {}),
    repository: lane.repository!, worktree: lane.worktree!, branch: lane.branch, baseCommit: lane.baseCommit, target: lane.target,
    createdAt: lane.createdAt!, state: lane.state!,
    ...(lane.exitCode !== undefined ? { exitCode: lane.exitCode } : {}), ...(lane.mergedAt ? { mergedAt: lane.mergedAt } : {}), ...(lane.reason ? { reason: lane.reason } : {}),
    ...(switches ? { switches } : {}),
    ...(lastGates ? { lastGates } : {}),
  };
}

/** `lane.lastGates`: only its shape, not each JobCheckResult field (those are Hydra's own gates output, never user input). */
function validateLastGates(value: unknown, where: string): LaneGatesRecord | undefined {
  if (value === undefined) return undefined;
  const record = value as Partial<LaneGatesRecord> | undefined;
  if (!record || typeof record !== 'object') throw new Error(`${where} has an invalid gates record.`);
  if (record.source !== 'gates' && record.source !== 'checks' && record.source !== 'none') throw new Error(`${where} has an invalid gates source.`);
  if (typeof record.at !== 'string' || !record.at || Number.isNaN(Date.parse(record.at))) throw new Error(`${where} has an invalid gates time.`);
  if (!Array.isArray(record.results)) throw new Error(`${where} has an invalid gates result list.`);
  return { source: record.source, at: record.at, results: record.results as JobCheckResult[] };
}

/** `lane.switches`, field by field; kept short (the newest `maxLaneSwitches`), never guessed at. */
function validateLaneSwitches(value: unknown, where: string): LaneSwitch[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${where} has an invalid switch history.`);
  const isProvider = (candidate: unknown): candidate is Provider => candidate === 'claude' || candidate === 'codex';
  const switches = value.map((entry): LaneSwitch => {
    const item = entry as Partial<LaneSwitch> | undefined;
    if (!item || typeof item !== 'object' || !isProvider(item.from) || !isProvider(item.to) || item.from === item.to) throw new Error(`${where} has an invalid switch entry.`);
    if (typeof item.at !== 'string' || !item.at || item.at.length > 64 || Number.isNaN(Date.parse(item.at))) throw new Error(`${where} has an invalid switch time.`);
    if (!laneSwitchReasons.includes(item.reason as LaneSwitchReason)) throw new Error(`${where} has an invalid switch reason.`);
    return { from: item.from, to: item.to, at: item.at, reason: item.reason as LaneSwitchReason };
  });
  return switches.slice(-maxLaneSwitches);
}

export const restartReason = 'Hydra restarted';
/** No terminal survives an extension-host restart: running lanes become exited. Their worktrees are untouched. */
export function restartedLanes(lanes: readonly Lane[]): { lanes: Lane[]; changed: boolean } {
  let changed = false;
  const next = lanes.map(lane => {
    if (lane.state !== 'running') return lane;
    changed = true;
    const { exitCode: _exitCode, ...rest } = lane;
    return { ...rest, state: 'exited' as const, reason: restartReason };
  });
  return { lanes: next, changed };
}

/** Closed lanes are kept briefly for the record; older ones are dropped. */
const keptClosed = 50;
interface StoreFile { version: 1; lanes: Lane[] }

/**
 * The lanes of one window, in `lanes.json` under the window's storage folder.
 * One writer (this extension host); writes are serialized and atomic, so a crash
 * midway leaves the previous file readable.
 */
export class LaneStore {
  private lanes = new Map<string, Lane>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly directory: string, private readonly log?: (line: string) => void) {}
  get file(): string { return path.join(this.directory, 'lanes.json'); }

  /** Load the store and apply the restart transition. A malformed lane is skipped, never guessed at. */
  async load(): Promise<Lane[]> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      let stored: unknown[] = [];
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoreFile>;
        if (parsed?.version !== 1 || !Array.isArray(parsed.lanes)) throw new Error('Unsupported lane store.');
        stored = parsed.lanes;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.(`[lanes] lanes.json could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      const valid: Lane[] = [];
      for (const item of stored) {
        try { valid.push(validateLane(item)); } catch (error) { this.log?.(`[lanes] skipped: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const { lanes, changed } = restartedLanes(valid);
      this.lanes = new Map(lanes.map(lane => [lane.id, lane]));
      this.loaded = true;
      if (changed || valid.length !== stored.length) await this.write();
      return this.list();
    });
  }

  list(): Lane[] { return [...this.lanes.values()].map(lane => structuredClone(lane)); }
  /** Lanes that aren't closed, oldest first. */
  open(): Lane[] { return this.list().filter(lane => lane.state !== 'closed'); }
  get(id: string): Lane | undefined { const lane = this.lanes.get(id); return lane && structuredClone(lane); }

  async add(lane: Lane): Promise<Lane> {
    return this.serialize(async () => {
      this.assertLoaded();
      const valid = validateLane(lane);
      if (this.lanes.has(valid.id)) throw new Error(`Lane ${valid.id} already exists.`);
      this.lanes.set(valid.id, valid);
      try { await this.write(); } catch (error) { this.lanes.delete(valid.id); throw error; }
      return structuredClone(valid);
    });
  }

  /** Change a lane. A state change must be in the transition table; a closed lane can't change. */
  async update(id: string, patch: Partial<Pick<Lane, 'state' | 'exitCode' | 'mergedAt' | 'reason' | 'provider' | 'switches' | 'lastGates'>>): Promise<Lane> {
    return this.serialize(async () => {
      this.assertLoaded();
      const lane = this.lanes.get(id);
      if (!lane) throw new Error(`Unknown lane ${id}.`);
      if (lane.state === 'closed') throw new Error(`Lane ${lane.name} is closed.`);
      if (patch.state && !canLaneTransition(lane.state, patch.state)) throw new Error(`Lane ${lane.name} cannot go from ${lane.state} to ${patch.state}.`);
      const next: Lane = { ...lane };
      for (const [key, value] of Object.entries(patch) as [keyof Lane, unknown][]) {
        if (value === undefined) delete next[key]; else (next as unknown as Record<string, unknown>)[key] = value;
      }
      const valid = validateLane(next);
      this.lanes.set(id, valid);
      try { await this.write(); } catch (error) { this.lanes.set(id, lane); throw error; }
      return structuredClone(valid);
    });
  }

  /** Forget a lane entirely: only for a lane whose start was rolled back. */
  async remove(id: string): Promise<void> {
    return this.serialize(async () => {
      const lane = this.lanes.get(id);
      if (!lane) return;
      this.lanes.delete(id);
      try { await this.write(); } catch (error) { this.lanes.set(id, lane); throw error; }
    });
  }

  private assertLoaded(): void { if (!this.loaded) throw new Error('Hydra lanes are not loaded yet.'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async write(): Promise<void> {
    const all = [...this.lanes.values()];
    const closed = all.filter(lane => lane.state === 'closed');
    const dropped = new Set(closed.slice(0, Math.max(0, closed.length - keptClosed)).map(lane => lane.id));
    for (const id of dropped) this.lanes.delete(id);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const body: StoreFile = { version: 1, lanes: all.filter(lane => !dropped.has(lane.id)) };
    await writeFile(temporary, JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 });
    try { await replaceAtomic(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}

// ---- The first prompt ----

export interface LanePreambleOther { name: string; provider: Provider; goal?: string; files: readonly string[] }
export const lanePreambleMax = 4000;
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';

/**
 * The first prompt of a lane with a goal: one line (it is passed as a command-line
 * argument), capped at lanePreambleMax characters. It says where the lane is,
 * what the other lanes are doing and which files they touch, then the task.
 */
export function lanePreamble(lane: Pick<Lane, 'name' | 'branch' | 'goal'>, others: readonly LanePreambleOther[]): string {
  const head = `You are working in Hydra lane "${oneLine(lane.name)}" on branch ${lane.branch}.`;
  const advice = 'Call hydra_lanes to check again before large changes, and avoid editing files other lanes are changing.';
  const task = `Your task: ${clip(oneLine(lane.goal || ''), laneGoalMax) || 'wait for the user.'}`;
  const listed = others.slice(0, 8).map(other => {
    const files = other.files.slice(0, 5).map(file => clip(oneLine(file), 80));
    const more = other.files.length > files.length ? ` and ${other.files.length - files.length} more` : '';
    const goal = other.goal ? clip(oneLine(other.goal), 80) : 'no goal given';
    return `${oneLine(other.name)} (${providerName(other.provider)}): ${goal}, ${files.length ? `files ${files.join(', ')}${more}` : 'no files changed yet'}`;
  });
  let middle = listed.length ? `Other lanes in progress: ${listed.join('; ')}${others.length > listed.length ? `; and ${others.length - listed.length} more` : ''}.` : 'No other lanes are in progress.';
  const budget = lanePreambleMax - head.length - advice.length - task.length - 3;
  if (middle.length > budget) middle = clip(middle, Math.max(0, budget));
  return clip([head, middle, advice, task].filter(Boolean).join(' '), lanePreambleMax);
}

/**
 * The first prompt after a provider switch (docs/Gates_Plan.md, section 2: "Continue
 * in <Other>" and the manual switch): the lane's usual preamble, plus the handoff
 * flattened to one line (it is passed as a command-line argument, like the preamble).
 */
export const laneContinuePromptMax = lanePreambleMax + 4000;
export function laneContinuePrompt(lane: Pick<Lane, 'name' | 'branch' | 'goal'>, from: Provider, others: readonly LanePreambleOther[], handoffMarkdown: string): string {
  const preamble = lanePreamble(lane, others);
  const handoff = clip(oneLine(handoffMarkdown), laneContinuePromptMax - preamble.length - 40);
  return clip(`${preamble} You are continuing in this lane after ${providerName(from)} hit its usage limit. Handoff: ${handoff}`, laneContinuePromptMax);
}
