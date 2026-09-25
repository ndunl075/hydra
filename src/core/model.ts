import type { Lane } from './lanes';
import type { Plan } from './plans';
import type { HeadCheckView, JobCheckResult } from './jobs';
export type { HeadCheckView } from './jobs';

export type Provider = 'claude' | 'codex';
export interface ProviderInfo { provider: Provider; executable?: string; available: boolean }
export interface ProviderDiagnostic {
  provider: Provider; executable?: string; status: 'checking' | 'checked' | 'unavailable' | 'error';
  version?: string; checkedAt: string; advertised: string[]; error?: string;
  probes: { args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string }[];
}
/** The work a handoff window was opened for (a hydra.handoff workspace setting). */
export interface HandoffTask { id: string; title: string; prompt: string; repository: string; worktree: string; branch: string; baseCommit: string; provider: Provider }
export interface Handoff { version: 1; task: HandoffTask }
export interface OfficialExtensionInfo { provider: Provider; extensionId: string; installed: boolean; version?: string; commandAvailable: boolean; commandTitle: string }
/** One Hydra helper as the dashboard shows it (docs/Official_Extensions_Plan.md, Phase 6). */
export interface HelperJobView {
  id: string; title: string; state: string; provider: Provider; createdAt: string; finishedAt?: string;
  progress?: string; question?: string; reason?: string; branch?: string; commit?: string; summary?: string;
  changedFiles: number; checks: HeadCheckView[];
  /** The repository the lead works in, where the helper's worktree was branched. */
  repository?: string;
  worktree?: string;
  dependsOn: string[];
  /** The chat that started it (one Claude Code or Codex conversation), when known; `lane` when that chat is a Hydra lane. */
  lead?: { sessionId: string; provider?: Provider; label?: string; lane?: string };
  /** Done, and its commit is already in the lead folder's HEAD. */
  merged?: boolean;
  startedAt?: string;
  writeScope?: string[];
}
export interface Snapshot {
  mode: 'editor' | 'agents'; busy: boolean; error?: string;
  helpers?: HelperJobView[];
  handoff?: Handoff; officialExtensions?: OfficialExtensionInfo[];
  /** The Planner (docs/Lanes_And_Planner_Plan.md, section 4). hydra.defaultProvider, so the New plan card and status text can name it. */
  plans?: Plan[];
  defaultProvider?: Provider;
}
export type ClientMessage =
  | LaneClientMessage
  | { type: 'ready' | 'editor' | 'agents' | 'refresh' | 'settings' }
  | { type: 'checkProvider'; provider: Provider }
  | { type: 'openOfficial' | 'showOfficial' | 'copyHandoffPrompt' }
  | { type: 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer' | 'helperEvidence'; jobId: string }
  | { type: 'helperStopAll' }
  // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4). Kept as its own block: ----
  // ---- Phase 1 (Lanes) adds its own lane messages to this union separately.        ----
  | { type: 'planCreate'; title: string; brief: string }
  | { type: 'planCreateEmpty'; title: string }
  | { type: 'planRetry' | 'planCancel' | 'planDelete' | 'planAddJob' | 'planRun' | 'planStartEmpty'; id: string }
  | { type: 'planSaveJob'; id: string; key: string; title: string; brief: string; provider?: Provider }
  | { type: 'planDeleteJob'; id: string; key: string }
  | { type: 'planDependsOn'; id: string; key: string }
  | { type: 'planAddDependency' | 'planRemoveDependency'; id: string; key: string; dependsOn: string };

export function parseMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== 'object') throw new Error('Invalid message.');
  const message = value as Record<string, unknown>;
  const string = (key: string, max = 500): string => {
    const result = message[key];
    if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new Error(`Invalid ${key}.`);
    return result;
  };
  const type = string('type');
  const lane = parseLaneMessage(message, type);
  if (lane) return lane;
  if (type === 'helperReview' || type === 'helperLog' || type === 'helperCancel' || type === 'helperAnswer' || type === 'helperEvidence') {
    const jobId = string('jobId'); if (!/^[a-f0-9]{12}$/.test(jobId)) throw new Error('Invalid head job ID.');
    return { type, jobId };
  }
  if (type === 'helperStopAll') return { type };
  if (type === 'checkProvider') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    return { type, provider };
  }
  if (['ready', 'editor', 'agents', 'refresh', 'settings', 'openOfficial', 'showOfficial', 'copyHandoffPrompt'].includes(type)) return { type } as ClientMessage;
  // ---- Planner ----
  const planId = (): string => { const id = string('id', 20); if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid plan ID.'); return id; };
  const jobKey = (): string => { const key = string('key', 30); if (!/^[a-z0-9-]{1,24}$/.test(key)) throw new Error('Invalid job key.'); return key; };
  const provider = (): Provider | undefined => {
    if (message.provider === undefined) return undefined;
    const value = string('provider'); if (value !== 'claude' && value !== 'codex') throw new Error('Unknown provider.'); return value;
  };
  if (type === 'planCreate') return { type, title: string('title', 200), brief: string('brief', 8000) };
  if (type === 'planCreateEmpty') return { type, title: string('title', 200) };
  if (type === 'planRetry' || type === 'planCancel' || type === 'planDelete' || type === 'planAddJob' || type === 'planRun' || type === 'planStartEmpty') return { type, id: planId() };
  if (type === 'planSaveJob') return { type, id: planId(), key: jobKey(), title: string('title', 80), brief: string('brief', 4000), provider: provider() };
  if (type === 'planDeleteJob') return { type, id: planId(), key: jobKey() };
  if (type === 'planDependsOn') return { type, id: planId(), key: jobKey() };
  if (type === 'planAddDependency' || type === 'planRemoveDependency') {
    const id = planId(), key = jobKey(), dependsOn = string('dependsOn', 30);
    if (!/^[a-z0-9-]{1,24}$/.test(dependsOn)) throw new Error('Invalid job key.');
    if (dependsOn === key) throw new Error('A job cannot depend on itself.');
    return { type, id, key, dependsOn };
  }
  throw new Error('Unknown command.');
}

// ---- Lanes (docs/Lanes_And_Planner_Plan.md, "Extension-webview protocol") ----

/** What a lane's coordination pass found (src/core/laneSync.ts). */
export interface LaneSyncView {
  changedFiles: string[];
  conflicts: { laneId: string; files: string[] }[];
  targetConflicts: string[];
  behind: number;
  /** Uncommitted changes (untracked files included): the UI offers Commit. */
  dirty: boolean;
  checkedAt: string;
  error?: string;
}
/** A lane as the webview shows it: the record, its last sync, and whether its terminal is alive. */
export type LaneView = Lane & { sync?: LaneSyncView; running: boolean };
export type LaneAction = 'commit' | 'merge' | 'update' | 'pr' | 'close' | 'resume' | 'restart' | 'diff' | 'openWindow' | 'refresh' | 'switchProvider' | 'runGates' | 'evidence';
export const laneActions: readonly LaneAction[] = ['commit', 'merge', 'update', 'pr', 'close', 'resume', 'restart', 'diff', 'openWindow', 'refresh', 'switchProvider', 'runGates', 'evidence'];
export type AgentsView = 'canvas' | 'lanes';

/** The lane tile's usage-limit banner (docs/Gates_Plan.md, section 2). Buttons match src/core/limitOffer.ts's LaneOfferButtonId. */
export type LaneOfferButtonId = 'continueOther' | 'viewHandoff' | 'wait';
export interface LaneLimitOfferView { provider: Provider; message: string; buttons: LaneOfferButtonId[] }

/** Webview to extension. */
export type LaneClientMessage =
  | { type: 'laneNew'; name: string; provider: Provider; goal?: string }
  /** After the Lanes view mounts: the extension replays every terminal's buffer. */
  | { type: 'laneAttach' }
  | { type: 'laneInput'; id: string; data: string }
  | { type: 'laneResize'; id: string; cols: number; rows: number }
  | { type: 'laneAction'; id: string; action: LaneAction }
  /** A button on the lane's usage-limit banner. */
  | { type: 'laneLimitAction'; id: string; action: LaneOfferButtonId }
  /** Cancel an in-progress `hydra.lanes.onLimit: "switch"` countdown. */
  | { type: 'laneCancelSwitch'; id: string }
  /** Remember the view; focus a lane or head. */
  | { type: 'view'; view: AgentsView; focus?: string };

/** Extension to webview. A `laneReplay` replaces what the terminal shows; `laneData` appends to it. */
export type LaneServerMessage =
  | { type: 'lanes'; lanes: LaneView[]; terminals: boolean }
  | { type: 'laneData'; id: string; data: string }
  | { type: 'laneReplay'; id: string; data: string }
  /** For the New lane form. */
  | { type: 'laneError'; message: string }
  | { type: 'show'; view: AgentsView; focus?: string }
  /** The lane's usage-limit banner; `offer` undefined clears it. */
  | { type: 'laneLimit'; id: string; offer?: LaneLimitOfferView }
  /** `hydra.lanes.onLimit: "switch"`: the tile counts down to `deadline` (epoch ms), then switches to `to`. */
  | { type: 'laneSwitchCountdown'; id: string; to: Provider; deadline: number }
  /** The countdown ended (cancelled, or the switch happened — a fresh `lanes`/`laneLimit` message follows). */
  | { type: 'laneSwitchCancelled'; id: string }
  /**
   * Gates running on a lane (docs/Gates_Plan.md, "Lanes"): as each gate starts
   * and finishes, for the tile header's "Gates: unit ✓ · review …". `running`
   * undefined means the run just finished; the lane's own `lastGates` (in the
   * next `lanes` message) then has the final chips.
   */
  | { type: 'laneGates'; id: string; done: JobCheckResult[]; running?: string };

export const laneInputMaxBytes = 64 * 1024;
const utf8Length = (text: string) => text.length <= laneInputMaxBytes / 4 ? text.length : new TextEncoder().encode(text).byteLength;

/** Validate a lane message from the webview; undefined when `type` isn't one. */
export function parseLaneMessage(message: Record<string, unknown>, type: string): LaneClientMessage | undefined {
  const laneId = (key: string, what: string): string => {
    const value = message[key];
    if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) throw new Error(`Invalid ${what}.`);
    return value;
  };
  const integer = (key: string, min: number, max: number): number => {
    const value = message[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}.`);
    return value;
  };
  switch (type) {
    case 'laneNew': {
      const { name, provider, goal } = message;
      if (typeof name !== 'string' || /[\u0000-\u001f\u007f]/.test(name) || !name.trim() || name.trim().length > 40) throw new Error('Invalid lane name.');
      if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
      if (goal !== undefined && (typeof goal !== 'string' || goal.length > 2000 || goal.includes('\0'))) throw new Error('Invalid lane goal.');
      return { type, name: name.trim(), provider, ...(typeof goal === 'string' && goal.trim() ? { goal } : {}) };
    }
    case 'laneAttach': return { type };
    case 'laneInput': {
      const data = message.data;
      if (typeof data !== 'string' || utf8Length(data) > laneInputMaxBytes) throw new Error('Invalid lane input.');
      return { type, id: laneId('id', 'lane ID'), data };
    }
    case 'laneResize': return { type, id: laneId('id', 'lane ID'), cols: integer('cols', 20, 500), rows: integer('rows', 5, 200) };
    case 'laneAction': {
      const action = message.action;
      if (typeof action !== 'string' || !laneActions.includes(action as LaneAction)) throw new Error('Unknown lane action.');
      return { type, id: laneId('id', 'lane ID'), action: action as LaneAction };
    }
    case 'laneLimitAction': {
      const action = message.action;
      if (action !== 'continueOther' && action !== 'viewHandoff' && action !== 'wait') throw new Error('Unknown lane limit action.');
      return { type, id: laneId('id', 'lane ID'), action };
    }
    case 'laneCancelSwitch': return { type, id: laneId('id', 'lane ID') };
    case 'view': {
      const view = message.view;
      if (view !== 'canvas' && view !== 'lanes') throw new Error('Unknown view.');
      return { type, view, ...(message.focus !== undefined ? { focus: laneId('focus', 'lane or head ID') } : {}) };
    }
  }
  return undefined;
}
