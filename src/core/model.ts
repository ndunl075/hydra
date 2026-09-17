import { buildTaskPrompt, parseBrief, parseHandoffSummary } from './taskContext';
import type { UsageSummary } from './usage';
export type Provider = 'claude' | 'codex';
export interface TaskBrief { goal: string; constraints: string; relevantPaths: string; acceptance: string; testCommands: string }
export interface TaskHandoffSummary { summary: string; decisions: string; validation: string; unresolved: string; evidenceRefs: string }
export type TaskState = 'idle' | 'external' | 'running' | 'interrupted' | 'error';
export interface Task {
  id: string; title: string; prompt: string; repository: string; worktree: string;
  branch: string; baseCommit: string; integrationTarget: string; provider: Provider;
  interface: 'interactive-cli' | 'official-extension' | 'managed-cli'; state: TaskState; createdAt: string; updatedAt: string;
  sessionId?: string; sessionProvider?: Provider; providerVersion?: string;
  error?: string;
  reviewedCommit?: ReviewedCommit;
  brief?: TaskBrief;
  contextLockedAt?: string;
  handoffSummary?: TaskHandoffSummary;
}
export interface ReviewedCommit { commit: string; tree: string; baseCommit: string; reviewedAt: string }
export interface PreparedReview { token: string; head: string; tree: string; baseCommit: string; branch: string; indexHash: string; createdAt: string; files: FileChange[] }
export type DiffLayer = 'combined' | 'committed' | 'staged' | 'unstaged' | 'untracked';
export const diffLabels: Record<DiffLayer, string> = { combined: 'Base → saved files', committed: 'Committed', staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' };
export interface FileChange { path: string; beforePath?: string; status: string; layer: DiffLayer }
export interface TaskFile { path: string; status: string; changes?: FileChange[] }
export interface ProviderInfo { provider: Provider; executable?: string; available: boolean }
export interface ProviderDiagnostic {
  provider: Provider; executable?: string; status: 'checking' | 'checked' | 'unavailable' | 'error';
  version?: string; checkedAt: string; advertised: string[]; error?: string;
  probes: { args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string }[];
}
export interface Draft { title: string; prompt: string; provider: Provider; brief?: TaskBrief }
export interface Turn {
  provider?: Provider;
  id: string; prompt: string; text: string; status: 'running' | 'completed' | 'error' | 'interrupted';
  createdAt: string; error?: string; permissionDenials?: number;
  textTruncated?: boolean;
  usage?: { input: number; output: number; cacheRead?: number; cacheCreated?: number; estimatedUsd?: number };
  usageSource?: 'claude-result' | 'codex-last-request';
  /** Cumulative root-thread snapshot; never sum these across turns. */
  threadUsage?: { sessionId: string; input: number; output: number; cacheRead?: number; cacheCreated?: number };
}
export interface Approval { id: string; kind: 'command' | 'file' | 'network'; detail: string }
export interface SessionView { version: 1; turns: Turn[]; active?: boolean; totalTurns?: number; approvals?: Approval[] }
export type HandoffTask = Pick<Task, 'id' | 'title' | 'prompt' | 'repository' | 'worktree' | 'branch' | 'baseCommit' | 'provider'>;
export interface Handoff { version: 1; task: HandoffTask }
export interface OfficialExtensionInfo { provider: Provider; extensionId: string; installed: boolean; version?: string; commandAvailable: boolean; commandTitle: string }
export interface Snapshot {
  tasks: Task[]; selectedId?: string; mode: 'editor' | 'agents'; repositories: string[];
  providers: ProviderInfo[]; files: TaskFile[]; busy: boolean; error?: string; draft?: Draft;
  handoff?: Handoff; officialExtensions?: OfficialExtensionInfo[];
  diagnostics?: ProviderDiagnostic[];
  session?: SessionView;
  /** Local activity only; no other task's transcript or approval details. */
  taskActivity?: Record<string, { active: boolean; awaitingApproval: boolean }>;
  commitReview?: PreparedReview;
  usage?: { tasks: Record<string, UsageSummary>; projects: Record<string, UsageSummary> };
}
export type ClientMessage =
  | { type: 'ready' | 'editor' | 'refresh' | 'settings' }
  | { type: 'select' | 'launch' | 'terminal' | 'copyPrompt' | 'openWorktree' | 'stop' | 'releaseExternal' | 'startManaged' | 'showSessionDiagnostics'; id: string }
  | { type: 'followUp'; id: string; prompt: string }
  | { type: 'saveBrief'; id: string; brief: TaskBrief }
  | { type: 'saveHandoffSummary'; id: string; handoffSummary: TaskHandoffSummary }
  | { type: 'showTaskHandoff'; id: string }
  | { type: 'approve'; id: string; approvalId: string; decision: 'accept' | 'decline' }
  | { type: 'handoff'; id: string; provider: Provider }
  | { type: 'checkProvider' | 'showProviderDiagnostics'; provider: Provider }
  | { type: 'openOfficial' | 'showOfficial' | 'copyHandoffPrompt' }
  | { type: 'openFile'; id: string; path: string }
  | { type: 'openDiff'; id: string; path: string; layer: DiffLayer }
  | { type: 'prepareCommitReview'; id: string }
  | { type: 'openCommitReview'; id: string; token: string; path: string }
  | { type: 'commitReviewed'; id: string; token: string; message: string }
  | { type: 'create'; title: string; prompt: string; provider: Provider; repository: string; brief?: TaskBrief }
  | { type: 'draft'; title: string; prompt: string; provider: Provider; brief?: TaskBrief };

export function parseMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== 'object') throw new Error('Invalid message.');
  const message = value as Record<string, unknown>;
  const string = (key: string, max = 500): string => {
    const result = message[key];
    if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new Error(`Invalid ${key}.`);
    return result;
  };
  const type = string('type');
  if (['create', 'draft', 'startManaged', 'followUp', 'saveBrief'].includes(type) && ['model', 'effort', 'reasoningEffort', 'reasoning_effort'].some(key => key in message)) {
    throw new Error('Per-task model and effort overrides are not verified for these managed adapters. Configure the official provider or use its terminal; Hydra cannot confirm an Astra High preset.');
  }
  if (type === 'saveBrief' || type === 'saveHandoffSummary' || type === 'showTaskHandoff') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'showTaskHandoff') return { type, id };
    if (type === 'saveHandoffSummary') return { type, id, handoffSummary: parseHandoffSummary(message.handoffSummary) };
    const brief = parseBrief(message.brief);
    if (!brief.goal.trim()) throw new Error('Enter a task goal.');
    return { type, id, brief };
  }
  if (type === 'prepareCommitReview' || type === 'openCommitReview' || type === 'commitReviewed') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'prepareCommitReview') return { type, id };
    const token = string('token');
    if (!/^[a-f0-9]{24}$/.test(token)) throw new Error('Invalid review token.');
    if (type === 'openCommitReview') return { type, id, token, path: string('path', 4096) };
    const message = string('message', 500);
    if (!message.trim()) throw new Error('Enter a commit message.');
    return { type, id, token, message };
  }
  if (type === 'approve') {
    const id = string('id'), approvalId = string('approvalId'), decision = string('decision');
    if (!/^[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{12}$/.test(approvalId) || !['accept', 'decline'].includes(decision)) throw new Error('Invalid approval decision.');
    return { type, id, approvalId, decision } as ClientMessage;
  }
  if (type === 'checkProvider' || type === 'showProviderDiagnostics') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    return { type, provider };
  }
  if (['ready', 'editor', 'refresh', 'settings', 'openOfficial', 'showOfficial', 'copyHandoffPrompt'].includes(type)) return { type } as ClientMessage;
  if (type === 'handoff') {
    const id = string('id');
    const provider = string('provider');
    if (!/^[a-f0-9]{12}$/.test(id) || (provider !== 'claude' && provider !== 'codex')) throw new Error('Invalid handoff.');
    return { type, id, provider };
  }
  if (type === 'followUp') {
    const id = string('id'), prompt = string('prompt', 32000);
    if (!/^[a-f0-9]{12}$/.test(id) || !prompt.trim()) throw new Error('Invalid follow-up.');
    return { type, id, prompt };
  }
  if (['select', 'launch', 'terminal', 'copyPrompt', 'openWorktree', 'stop', 'releaseExternal', 'startManaged', 'showSessionDiagnostics'].includes(type)) {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    return { type, id } as ClientMessage;
  }
  if (type === 'openFile' || type === 'openDiff') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'openDiff') {
      const layer = string('layer');
      if (!['combined', 'committed', 'staged', 'unstaged', 'untracked'].includes(layer)) throw new Error('Invalid diff layer.');
      return { type, id, path: string('path', 4096), layer } as ClientMessage;
    }
    return { type, id, path: string('path', 4096) };
  }
  if (type === 'create' || type === 'draft') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const common = { title: string('title', 120), prompt: string('prompt', 32000), provider, ...(message.brief === undefined ? {} : { brief: parseBrief(message.brief) }) };
    if (type === 'draft') return { type, ...common } as ClientMessage;
    if (!common.title.trim() || !common.prompt.trim()) throw new Error('Enter a title and task prompt.');
    if (common.brief && !common.brief.goal.trim()) throw new Error('Enter a task goal.');
    if (common.brief && buildTaskPrompt(common.brief) !== common.prompt) throw new Error('The prompt preview does not match the task brief. Refresh before creating the task.');
    return { type, ...common, repository: string('repository', 4096) } as ClientMessage;
  }
  throw new Error('Unknown command.');
}
