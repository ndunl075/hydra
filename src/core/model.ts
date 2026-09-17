export type Provider = 'claude' | 'codex';
export type TaskState = 'idle' | 'external' | 'interrupted' | 'error';
export interface Task {
  id: string; title: string; prompt: string; repository: string; worktree: string;
  branch: string; baseCommit: string; integrationTarget: string; provider: Provider;
  interface: 'interactive-cli'; state: TaskState; createdAt: string; updatedAt: string;
  error?: string;
}
export interface TaskFile { path: string; status: string }
export interface ProviderInfo { provider: Provider; executable?: string; available: boolean }
export interface Draft { title: string; prompt: string; provider: Provider }
export interface Snapshot {
  tasks: Task[]; selectedId?: string; mode: 'editor' | 'agents'; repositories: string[];
  providers: ProviderInfo[]; files: TaskFile[]; busy: boolean; error?: string; draft?: Draft;
}
export type ClientMessage =
  | { type: 'ready' | 'editor' | 'refresh' | 'settings' }
  | { type: 'select' | 'launch' | 'terminal' | 'copyPrompt' | 'openWorktree' | 'stop'; id: string }
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
  if (['ready', 'editor', 'refresh', 'settings'].includes(type)) return { type } as ClientMessage;
  if (['select', 'launch', 'terminal', 'copyPrompt', 'openWorktree', 'stop'].includes(type)) {
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
