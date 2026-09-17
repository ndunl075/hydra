import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task } from './model';
export class LocalStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<Task[]> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'tasks.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data = JSON.parse(raw) as { version: number; tasks: unknown[] };
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('Unsupported Hydra task store. Original data has been retained.');
    const ids = new Set<string>();
    for (const value of data.tasks) {
      if (!value || typeof value !== 'object') throw new Error('Invalid task record.');
      const task = value as Task;
      if (!/^[a-f0-9]{12}$/.test(task.id) || ids.has(task.id) ||
        !['title', 'prompt', 'repository', 'worktree', 'branch', 'baseCommit', 'integrationTarget', 'createdAt', 'updatedAt'].every(key => typeof (task as unknown as Record<string, unknown>)[key] === 'string') ||
        !path.isAbsolute(task.repository) || !path.isAbsolute(task.worktree) || !/^[a-f0-9]{40,64}$/.test(task.baseCommit) ||
        !['claude', 'codex'].includes(task.provider) || !['interactive-cli', 'official-extension', 'managed-cli'].includes(task.interface) ||
        !['idle', 'external', 'running', 'interrupted', 'error'].includes(task.state) ||
        (task.sessionId !== undefined && (typeof task.sessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task.sessionId))) ||
        (task.providerVersion !== undefined && typeof task.providerVersion !== 'string')) throw new Error('Invalid task record. Original data has been retained.');
      ids.add(task.id);
    }
    return data.tasks as Task[];
  }
  save(tasks: Task[]): Promise<void> {
    const data = JSON.stringify({ version: 1, tasks }, null, 2);
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `tasks-${randomUUID()}.tmp`);
      await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'tasks.json'));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
