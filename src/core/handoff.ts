import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Handoff, HandoffTask, Provider } from './model';

export const officialProviders = {
  claude: { extensionId: 'anthropic.claude-code', command: 'claude-vscode.editor.open', commandTitle: 'Claude Code: Open in New Tab', docs: 'https://code.claude.com/docs/en/vs-code' },
  codex: { extensionId: 'openai.chatgpt', command: 'chatgpt.openSidebar', commandTitle: 'Codex: Open Codex Sidebar', docs: 'https://learn.chatgpt.com/docs/codex/ide' }
} as const;

const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');

export function parseHandoff(value: unknown): Handoff | undefined {
  if (value === null || value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid Hydra handoff descriptor.');
  const input = value as { version?: unknown; task?: unknown };
  if (input.version !== 1 || !input.task || typeof input.task !== 'object') throw new Error('Unsupported Hydra handoff descriptor.');
  const task = input.task as HandoffTask;
  if (task.provider !== 'claude' && task.provider !== 'codex') throw new Error('Unknown provider.');
  if (!text(task.title, 120) || !text(task.prompt, 32000) || !text(task.repository, 4096)) throw new Error('Invalid Hydra handoff task.');
  if (!/^[a-f0-9]{12}$/.test(task.id) || !/^[a-f0-9]{40,64}$/.test(task.baseCommit) ||
    typeof task.worktree !== 'string' || !path.isAbsolute(task.worktree) || !path.isAbsolute(task.repository) ||
    typeof task.branch !== 'string' || task.branch.length > 256 || !task.branch.startsWith('agent/') || task.branch.includes('\0')) throw new Error('Invalid Hydra handoff task.');
  return { version: 1, task: {
    id: task.id, title: task.title, prompt: task.prompt, provider: task.provider,
    repository: task.repository, worktree: task.worktree, branch: task.branch, baseCommit: task.baseCommit
  } };
}

/** Writes a .code-workspace that opens one worktree with its handoff descriptor. */
export async function createHandoffWorkspace(directory: string, task: HandoffTask, provider: Provider): Promise<string> {
  const handoff = parseHandoff({ version: 1, task: { ...task, provider } })!;
  await mkdir(directory, { recursive: true });
  const workspace = path.join(directory, `${task.id}-${provider}.code-workspace`);
  const temporary = `${workspace}-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({
    folders: [{ name: `${task.title} · ${provider === 'claude' ? 'Claude Code' : 'Codex'}`, path: task.worktree }],
    settings: { 'hydra.handoff': handoff },
    extensions: { recommendations: [officialProviders[provider].extensionId] }
  }, null, 2), { flag: 'wx' });
  await rename(temporary, workspace);
  return workspace;
}
