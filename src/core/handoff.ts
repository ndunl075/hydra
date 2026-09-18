import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseMessage, type Handoff, type HandoffTask, type Provider, type Task } from './model';

export const officialProviders = {
  claude: { extensionId: 'anthropic.claude-code', command: 'claude-vscode.editor.open', commandTitle: 'Claude Code: Open in New Tab', docs: 'https://code.claude.com/docs/en/vs-code' },
  codex: { extensionId: 'openai.chatgpt', command: 'chatgpt.openSidebar', commandTitle: 'Codex: Open Codex Sidebar', docs: 'https://learn.chatgpt.com/docs/codex/ide' }
} as const;

export function parseHandoff(value: unknown): Handoff | undefined {
  if (value === null || value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid Hydra handoff descriptor.');
  const input = value as { version?: unknown; task?: unknown };
  if (input.version !== 1 || !input.task || typeof input.task !== 'object') throw new Error('Unsupported Hydra handoff descriptor.');
  const task = input.task as HandoffTask;
  parseMessage({ type: 'create', title: task.title, prompt: task.prompt, provider: task.provider, repository: task.repository });
  if (!/^[a-f0-9]{12}$/.test(task.id) || !/^[a-f0-9]{40,64}$/.test(task.baseCommit) ||
    typeof task.worktree !== 'string' || !path.isAbsolute(task.worktree) || !path.isAbsolute(task.repository) ||
    typeof task.branch !== 'string' || task.branch.length > 256 || !task.branch.startsWith('agent/') || task.branch.includes('\0')) throw new Error('Invalid Hydra handoff task.');
  return { version: 1, task: {
    id: task.id, title: task.title, prompt: task.prompt, provider: task.provider,
    repository: task.repository, worktree: task.worktree, branch: task.branch, baseCommit: task.baseCommit
  } };
}

export async function createHandoffWorkspace(directory: string, task: Task, provider: Provider): Promise<string> {
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

export function assertHandoffAllowed(task: Task, hasTerminal: boolean): void {
  if (task.state === 'discarded') throw new Error('Restore this discarded task before handing off a writer.');
  if (hasTerminal) throw new Error('Stop this task terminal before handing off to an official extension.');
  if (task.interface === 'official-extension') throw new Error('This task is already externally owned. Stop that session and return ownership before another handoff.');
}
export function assertCliAllowed(task: Task): void {
  if (task.state === 'discarded') throw new Error('Restore this discarded task before launching a writer.');
  if (task.interface === 'official-extension') throw new Error('This task belongs to an external extension session. Stop it in its window, then use “I stopped the external session” before launching a CLI.');
}

export async function handoffTask(task: Task, directory: string, provider: Provider, hasTerminal: boolean,
  persist: () => Promise<void>, open: (workspace: string) => Promise<void>): Promise<string> {
  assertHandoffAllowed(task, hasTerminal);
  const workspace = await createHandoffWorkspace(directory, task, provider);
  task.interface = 'official-extension'; task.state = 'external'; task.provider = provider;
  task.error = undefined;
  task.updatedAt = new Date().toISOString();
  // Save ownership before opening another process. An ambiguous failure must not permit a second writer.
  await persist();
  try { await open(workspace); }
  catch (error) {
    task.error = 'Opening the handoff window could not be confirmed. Check it before returning this task to the CLI.';
    await persist();
    throw error;
  }
  return workspace;
}
