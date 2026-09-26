import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';
import type { JobCheckResult } from './jobs';
import type { GitMetaFingerprint } from './git';

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
  /**
   * When this lane last became exited (docs/Lanes_And_Planner_Plan.md,
   * "Canvas tidy-up"): drives the 10-minute "Parked lanes" chip. Set whenever
   * the lane's state becomes exited; cleared on resume or restart.
   */
  exitedAt?: string;
  /** Why Hydra stopped the lane's terminal, when it did (for example "Hydra restarted"). */
  reason?: string;
  /** Provider switches this lane has made (docs/Gates_Plan.md, section 2: "Continue in <Other>" and the manual "Switch to <Other>"). Oldest first. */
  switches?: LaneSwitch[];
  /** The last gates run on this lane (docs/Gates_Plan.md, "Lanes"): Run gates, or Merge when gates.json says "onMerge". Kept for the tile's chips and View evidence; only the most recent run. */
  lastGates?: LaneGatesRecord;
  // ---- Plan lanes (docs/Plan_Lanes_Plan.md, "Starting a lane job") ----
  /** The plan job this lane runs. Cancel job removes it; the lane then carries on as an ordinary lane. */
  plan?: LanePlanLink;
  /** The lane HEAD that Merge merged: a plan job's result when it is done by merging. */
  mergedHead?: string;
  /** How the lane was closed, so a plan can say whether its branch was kept. */
  closedAs?: LaneCloseMode;
  // ---- Packs (docs/Packs_Plan.md, "Lanes") ----
  /** The role it was started with. Resolved again at every launch; when it is gone, the lane runs without it and its tile says why. */
  role?: LaneRole;
  /** 1.4 (docs/Hydra_Improvements.md): the git metadata fingerprint (gitMetaFingerprint) of the shared .git when this lane started. Compared again at Merge and at Mark job done; a change is a warning (interactive) or a refusal (hydra.lanes.action). */
  gitMeta?: GitMetaFingerprint;
}
/** A lane's role: a pack's id and one of its roles' ids ("coding" and "reviewer"). */
export interface LaneRole { pack: string; role: string }
const laneRolePattern = /^([a-z0-9-]{1,24})\/([a-z0-9-]{1,24})$/;
/** A role as the New lane form, `hydra.lanes.start` and a plan name it: "pack/role". */
export function parseLaneRole(value: unknown): LaneRole | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const match = typeof value === 'string' ? laneRolePattern.exec(value) : null;
  if (!match) throw new Error('Name the lane\'s role with its pack, like "coding/reviewer".');
  return { pack: match[1]!, role: match[2]! };
}
export const laneRoleRef = (role: LaneRole): string => `${role.pack}/${role.role}`;

export type LaneCloseMode = 'merged' | 'keep' | 'delete';
export const laneCloseModes: readonly LaneCloseMode[] = ['merged', 'keep', 'delete'];

export interface LaneGatesRecord {
  /** Where the gates came from (GatesConfig['source']): 'gates' | 'checks' | 'none'. */
  source: 'gates' | 'checks' | 'none';
  at: string;
  results: JobCheckResult[];
  /**
   * The lane HEAD the gates ran on, recorded only when the lane was clean before and after
   * (docs/Plan_Lanes_Plan.md, section 3), so Merge can reuse a passing run on the same commit.
   */
  commit?: string;
  /** A fingerprint of the gates that ran: a passing run is reused only while the gates file says the same. */
  config?: string;
}

/**
 * A lane that runs a plan job (docs/Plan_Lanes_Plan.md): which plan and job, the
 * titles its first prompt names, what it started from, and its advised write scope.
 * `attempt` is the job's retry count, so a lane from an earlier try is never adopted.
 */
export interface LanePlanLink {
  planId: string; jobKey: string; planTitle: string; jobTitle: string;
  attempt?: number;
  startsFrom?: { title: string; commit: string }[];
  writeScope?: string[];
}
/** Where a plan lane's full brief is written, inside its worktree and ignored by git (decision 2): readable by either CLI, never committed. */
export const laneJobFolder = '.hydra-job';
export const laneJobBriefFile = `${laneJobFolder}/brief.md`;

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

/** `provider` is the form's choice: a role only sets the form's default (docs/Packs_Plan.md, "Lanes"). */
export interface LaneInput { name: string; provider: Provider; goal?: string; role?: LaneRole }

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
  const role = parseLaneRole(source.role);
  return { name: parseLaneName(source.name), provider: source.provider, ...(goal ? { goal } : {}), ...(role ? { role } : {}) };
}

export const newLaneId = (): string => randomBytes(6).toString('hex');

/**
 * A plan job's title as a lane name (docs/Plan_Lanes_Plan.md, "Starting a lane job"):
 * characters a lane name can't have become spaces, then it is cut to 40 characters,
 * falling back to "Plan job" when nothing is left. Always passes parseLaneName.
 */
export function laneNameFromTitle(title: string): string {
  const allowed = /[\p{L}\p{N} _.()#-]/u;
  const spaced = Array.from(typeof title === 'string' ? title : '').map(char => allowed.test(char) ? char : ' ').join('').replace(/\s+/g, ' ').trim();
  let name = '';
  for (const char of Array.from(spaced)) { if (name.length + char.length > laneNameMax) break; name += char; }
  name = name.trim();
  try { return parseLaneName(name); } catch { return 'Plan job'; }
}
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
  if (lane.exitedAt !== undefined && (!text(lane.exitedAt, 64) || Number.isNaN(Date.parse(lane.exitedAt)))) throw new Error(`${where} has an invalid exited time.`);
  if (lane.reason !== undefined && !text(lane.reason, 500)) throw new Error(`${where} has an invalid reason.`);
  const switches = validateLaneSwitches(lane.switches, where);
  const lastGates = validateLastGates(lane.lastGates, where);
  const plan = validatePlanLink(lane.plan, where);
  let role: LaneRole | undefined;
  if (lane.role !== undefined) {
    const stored = lane.role as Partial<LaneRole> | null;
    try { role = parseLaneRole(stored && typeof stored === 'object' && typeof stored.pack === 'string' && typeof stored.role === 'string' ? laneRoleRef(stored as LaneRole) : '-'); }
    catch { throw new Error(`${where} has an invalid role.`); }
  }
  if (lane.mergedHead !== undefined && (typeof lane.mergedHead !== 'string' || !fullSha.test(lane.mergedHead))) throw new Error(`${where} has an invalid merged commit.`);
  if (lane.closedAs !== undefined && !laneCloseModes.includes(lane.closedAs)) throw new Error(`${where} has an invalid close mode.`);
  const gitMeta = validateGitMeta(lane.gitMeta, where);
  return {
    id: lane.id, name, provider: lane.provider, ...(goal ? { goal } : {}),
    repository: lane.repository!, worktree: lane.worktree!, branch: lane.branch, baseCommit: lane.baseCommit, target: lane.target,
    createdAt: lane.createdAt!, state: lane.state!,
    ...(lane.exitCode !== undefined ? { exitCode: lane.exitCode } : {}), ...(lane.mergedAt ? { mergedAt: lane.mergedAt } : {}), ...(lane.exitedAt ? { exitedAt: lane.exitedAt } : {}), ...(lane.reason ? { reason: lane.reason } : {}),
    ...(switches ? { switches } : {}),
    ...(lastGates ? { lastGates } : {}),
    ...(plan ? { plan } : {}), ...(lane.mergedHead ? { mergedHead: lane.mergedHead } : {}), ...(lane.closedAs ? { closedAs: lane.closedAs } : {}),
    ...(role ? { role } : {}),
    ...(gitMeta ? { gitMeta } : {}),
  };
}

/** `lane.gitMeta` (1.4): a plain map of relative path to a sha256 hex digest, bounded like the equivalent check on a head job (src/core/jobs.ts). */
function validateGitMeta(value: unknown, where: string): GitMetaFingerprint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} has an invalid git metadata fingerprint.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error(`${where} has too many git metadata entries.`);
  const result: Record<string, string> = {};
  for (const [name, digest] of entries) {
    if (typeof name !== 'string' || !name || name.length > 300 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${where} has an invalid git metadata entry.`);
    result[name] = digest;
  }
  return result;
}

/** `lane.plan`, field by field (docs/Plan_Lanes_Plan.md): ids and keys by pattern, titles and scope by length. */
function validatePlanLink(value: unknown, where: string): LanePlanLink | undefined {
  if (value === undefined) return undefined;
  const link = value as Partial<LanePlanLink> | undefined;
  const text = (field: unknown, max: number): field is string => typeof field === 'string' && field.trim().length > 0 && field.length <= max && !field.includes('\0');
  if (!link || typeof link !== 'object' || typeof link.planId !== 'string' || !laneIdPattern.test(link.planId) || typeof link.jobKey !== 'string' || !/^[a-z0-9-]{1,24}$/.test(link.jobKey)) throw new Error(`${where} has an invalid plan link.`);
  if (!text(link.planTitle, 200) || !text(link.jobTitle, 80)) throw new Error(`${where} has an invalid plan title.`);
  if (link.attempt !== undefined && (!Number.isInteger(link.attempt) || link.attempt < 0 || link.attempt > 1000)) throw new Error(`${where} has an invalid plan attempt.`);
  if (link.startsFrom !== undefined && (!Array.isArray(link.startsFrom) || link.startsFrom.length > 12 || link.startsFrom.some(item => !item || !text(item.title, 80) || typeof item.commit !== 'string' || !fullSha.test(item.commit)))) throw new Error(`${where} has an invalid plan start.`);
  if (link.writeScope !== undefined && (!Array.isArray(link.writeScope) || link.writeScope.length > 32 || link.writeScope.some(entry => typeof entry !== 'string' || entry.length > 300 || entry.includes('\0')))) throw new Error(`${where} has an invalid plan write scope.`);
  return {
    planId: link.planId, jobKey: link.jobKey, planTitle: link.planTitle, jobTitle: link.jobTitle,
    ...(link.attempt ? { attempt: link.attempt } : {}),
    ...(link.startsFrom?.length ? { startsFrom: link.startsFrom.map(item => ({ title: item.title, commit: item.commit })) } : {}),
    ...(link.writeScope?.length ? { writeScope: [...link.writeScope] } : {}),
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
  if (record.commit !== undefined && (typeof record.commit !== 'string' || !fullSha.test(record.commit))) throw new Error(`${where} has an invalid gates commit.`);
  if (record.config !== undefined && (typeof record.config !== 'string' || !/^[a-f0-9]{16,64}$/.test(record.config))) throw new Error(`${where} has an invalid gates fingerprint.`);
  return { source: record.source, at: record.at, results: record.results as JobCheckResult[], ...(record.commit ? { commit: record.commit } : {}), ...(record.config ? { config: record.config } : {}) };
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
export function restartedLanes(lanes: readonly Lane[], now: number = Date.now()): { lanes: Lane[]; changed: boolean } {
  let changed = false;
  const next = lanes.map(lane => {
    if (lane.state !== 'running') return lane;
    changed = true;
    const { exitCode: _exitCode, ...rest } = lane;
    return { ...rest, state: 'exited' as const, reason: restartReason, exitedAt: new Date(now).toISOString() };
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
  async update(id: string, patch: Partial<Pick<Lane, 'state' | 'exitCode' | 'mergedAt' | 'exitedAt' | 'reason' | 'provider' | 'switches' | 'lastGates' | 'plan' | 'mergedHead' | 'closedAs'>>): Promise<Lane> {
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

/**
 * The role a lane's first prompt names (docs/Packs_Plan.md, "Lanes"): its label and, for a
 * Codex lane whose developer instructions can't carry the role, its text within `max`
 * characters (roleFirstPrompt in src/core/packs/launch.ts).
 */
export interface LanePromptRole { label: string; text?: (max: number) => string }
/** A Codex lane with a role but no goal, whose developer instructions can't carry it: the role, then wait (section 5). */
export function laneRolePrompt(role: LanePromptRole & { text: (max: number) => string }): string {
  const label = `Your role: ${oneLine(role.label)}.`, end = 'Wait for the user\'s first request.';
  return clip(`${label} ${oneLine(role.text(lanePreambleMax - label.length - end.length - 2))} ${end}`, lanePreambleMax);
}

export interface LanePreambleOther { name: string; provider: Provider; goal?: string; files: readonly string[] }
export const lanePreambleMax = 4000;
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';

/**
 * The sentence a plan lane's first prompt adds (docs/Plan_Lanes_Plan.md, "The first prompt"):
 * which job of which plan, what it starts from, the advised scope, where the full brief is,
 * and how the job ends. One line, at most 1500 characters.
 */
export function lanePlanSentence(plan: LanePlanLink): string {
  const intro = `This lane runs job "${clip(oneLine(plan.jobTitle), 80)}" of Hydra plan "${clip(oneLine(plan.planTitle), 120)}".`;
  // Where the brief is and how the job ends always survive; what it starts from and its scope get what is left.
  const end = ` The job's full brief is in ${laneJobBriefFile} (never committed); read it first. When the work is ready, commit it and call hydra_job_ready; the user marks the job done or merges the lane.`;
  const starts = plan.startsFrom?.length ? ` It starts from the work of ${plan.startsFrom.slice(0, 6).map(item => `${clip(oneLine(item.title), 60)} (${item.commit.slice(0, 12)})`).join(', ')}${plan.startsFrom.length > 6 ? ` and ${plan.startsFrom.length - 6} more` : ''}.` : '';
  const scope = plan.writeScope?.length ? ` Stay within ${plan.writeScope.slice(0, 8).map(entry => clip(oneLine(entry), 60) || 'the whole repository').join(', ')}${plan.writeScope.length > 8 ? ' and the rest of its scope' : ''} if you can.` : '';
  const middle = `${starts}${scope}`;
  const budget = 1500 - intro.length - end.length;
  return `${intro}${middle.length > budget ? clip(middle, Math.max(0, budget)) : middle}${end}`;
}

/**
 * The first prompt of a lane with a goal: one line (it is passed as a command-line
 * argument), capped at lanePreambleMax characters. It says where the lane is,
 * what the other lanes are doing and which files they touch, then the task. A
 * plan lane also says which job it runs (lanePlanSentence). A lane with a role
 * says so right after the first sentence: "Your role: Reviewer (Coding pack)."
 */
export function lanePreamble(lane: Pick<Lane, 'name' | 'branch' | 'goal'> & { plan?: LanePlanLink; promptRole?: LanePromptRole }, others: readonly LanePreambleOther[]): string {
  const where = `You are working in Hydra lane "${oneLine(lane.name)}" on branch ${lane.branch}.`;
  const roleSentence = lane.promptRole ? ` Your role: ${oneLine(lane.promptRole.label)}.` : '';
  const planSentence = lane.plan ? ` ${lanePlanSentence(lane.plan)}` : '';
  const advice = 'Call hydra_lanes to check again before large changes, and avoid editing files other lanes are changing.';
  const task = `Your task: ${clip(oneLine(lane.goal || ''), laneGoalMax) || 'wait for the user.'}`;
  // A Codex lane's role text, when its developer instructions can't carry it, gets what the task and the plan leave,
  // keeping room for the other lanes; at the least it says where the instructions are (roleFirstPrompt).
  const roleRoom = lanePreambleMax - where.length - roleSentence.length - planSentence.length - advice.length - task.length - 300;
  const roleText = lane.promptRole?.text ? ` ${oneLine(lane.promptRole.text(Math.max(400, roleRoom)))}` : '';
  const head = `${where}${roleSentence}${roleText}${planSentence}`;
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
export function laneContinuePrompt(lane: Pick<Lane, 'name' | 'branch' | 'goal'> & { plan?: LanePlanLink; promptRole?: LanePromptRole }, from: Provider, others: readonly LanePreambleOther[], handoffMarkdown: string): string {
  const preamble = lanePreamble(lane, others);
  const handoff = clip(oneLine(handoffMarkdown), laneContinuePromptMax - preamble.length - 40);
  return clip(`${preamble} You are continuing in this lane after ${providerName(from)} hit its usage limit. Handoff: ${handoff}`, laneContinuePromptMax);
}
