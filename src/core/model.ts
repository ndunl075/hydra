export type Provider = 'claude' | 'codex';
export type TaskState = 'idle' | 'external' | 'running' | 'interrupted' | 'error';
export interface Task {
  id: string; title: string; prompt: string; repository: string; worktree: string;
  branch: string; baseCommit: string; integrationTarget: string; provider: Provider;
  interface: 'interactive-cli' | 'official-extension' | 'managed-cli'; state: TaskState; createdAt: string; updatedAt: string;
  sessionId?: string; providerVersion?: string;
  error?: string;
}
export interface TaskFile { path: string; status: string }
export interface ProviderInfo { provider: Provider; executable?: string; available: boolean }
export interface ProviderDiagnostic {
  provider: Provider; executable?: string; status: 'checking' | 'checked' | 'unavailable' | 'error';
  version?: string; checkedAt: string; advertised: string[]; error?: string;
  probes: { args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string }[];
}
export interface Draft { title: string; prompt: string; provider: Provider }
export interface Turn {
  id: string; prompt: string; text: string; status: 'running' | 'completed' | 'error' | 'interrupted';
  createdAt: string; error?: string; permissionDenials?: number;
  textTruncated?: boolean;
  usage?: { input: number; output: number; cacheRead?: number; cacheCreated?: number; estimatedUsd?: number };
}
export interface SessionView { version: 1; turns: Turn[]; active?: boolean; totalTurns?: number }
export type HandoffTask = Pick<Task, 'id' | 'title' | 'prompt' | 'repository' | 'worktree' | 'branch' | 'baseCommit' | 'provider'>;
export interface Handoff { version: 1; task: HandoffTask }
export interface OfficialExtensionInfo { provider: Provider; extensionId: string; installed: boolean; version?: string; commandAvailable: boolean; commandTitle: string }
export interface Snapshot {
  tasks: Task[]; selectedId?: string; mode: 'editor' | 'agents'; repositories: string[];
  providers: ProviderInfo[]; files: TaskFile[]; busy: boolean; error?: string; draft?: Draft;
  handoff?: Handoff; officialExtensions?: OfficialExtensionInfo[];
  diagnostics?: ProviderDiagnostic[];
  session?: SessionView;
}
export type ClientMessage =
  | { type: 'ready' | 'editor' | 'refresh' | 'settings' }
  | { type: 'select' | 'launch' | 'terminal' | 'copyPrompt' | 'openWorktree' | 'stop' | 'releaseExternal' | 'startManaged' | 'showSessionDiagnostics'; id: string }
  | { type: 'followUp'; id: string; prompt: string }
  | { type: 'handoff'; id: string; provider: Provider }
  | { type: 'checkProvider' | 'showProviderDiagnostics'; provider: Provider }
  | { type: 'openOfficial' | 'showOfficial' | 'copyHandoffPrompt' }
  | { type: 'openFile'; id: string; path: string }
  | { type: 'create'; title: string; prompt: string; provider: Provider; repository: string }
  | { type: 'draft'; title: string; prompt: string; provider: Provider };

export function parseMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== 'object') throw new Error('Invalid message.');
  const message = value as Record<string, unknown>;
  const string = (key: string, max = 500): string => {
    const result = message[key];
    if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new Error(`Invalid ${key}.`);
    return result;
  };
  const type = string('type');
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
  if (type === 'openFile') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    return { type, id, path: string('path', 4096) };
  }
  if (type === 'create' || type === 'draft') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const common = { title: string('title', 120), prompt: string('prompt', 32000), provider };
    if (type === 'draft') return { type, ...common } as ClientMessage;
    if (!common.title.trim() || !common.prompt.trim()) throw new Error('Enter a title and task prompt.');
    return { type, ...common, repository: string('repository', 4096) } as ClientMessage;
  }
  throw new Error('Unknown command.');
}
