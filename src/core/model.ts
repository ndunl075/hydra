import type { Plan } from './plans';

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
  changedFiles: number; checks: { id: string; passed: boolean }[];
  /** The repository the lead works in, where the helper's worktree was branched. */
  repository?: string;
  worktree?: string;
  dependsOn: string[];
  /** The chat that started it (one Claude Code or Codex conversation), when known. */
  lead?: { sessionId: string; provider?: Provider; label?: string };
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
  | { type: 'ready' | 'editor' | 'agents' | 'refresh' | 'settings' }
  | { type: 'checkProvider'; provider: Provider }
  | { type: 'openOfficial' | 'showOfficial' | 'copyHandoffPrompt' }
  | { type: 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer'; jobId: string }
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
  if (type === 'helperReview' || type === 'helperLog' || type === 'helperCancel' || type === 'helperAnswer') {
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
