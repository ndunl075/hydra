import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { replaceAtomic } from './atomicFile';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SessionView } from './model';
import { validThreadUsage } from './usage';
import { validateTurnModelSettings } from './modelSelection';

export class SessionStore {
  private queue: Promise<void> = Promise.resolve();
  private artifactQueue: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}
  directory(id: string): string {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid session task ID.');
    return path.join(this.root, id);
  }
  rawPath(id: string, turnId: string): string {
    if (!/^[a-f0-9]{12}$/.test(turnId)) throw new Error('Invalid turn ID.');
    return path.join(this.directory(id), `${turnId}.events.jsonl`);
  }
  historyPath(id: string): string { return path.join(this.directory(id), 'history.json'); }
  async saveHandoff(id: string, content: string): Promise<string> {
    const directory = this.directory(id), filename = path.join(directory, 'handoff.md');
    const operation = this.artifactQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      await replaceAtomic(temporary, filename);
    });
    // A nonessential handoff export must not poison the provider evidence queue.
    this.artifactQueue = operation.catch(() => {});
    await operation;
    return filename;
  }
  async load(id: string): Promise<SessionView> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory(id), 'history.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, turns: [] }; throw error; }
    const data = JSON.parse(raw) as SessionView;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const ids = new Set<string>();
    if (data.version !== 1 || !Array.isArray(data.turns) || data.turns.some(turn => {
      if (!turn || typeof turn.id !== 'string' || !/^[a-f0-9]{12}$/.test(turn.id) || ids.has(turn.id) || typeof turn.prompt !== 'string' || typeof turn.text !== 'string' || typeof turn.createdAt !== 'string' || !['running', 'completed', 'error', 'interrupted'].includes(turn.status) ||
        (turn.provider !== undefined && !['claude', 'codex'].includes(turn.provider)) ||
        (turn.usageSource !== undefined && (turn.usageSource !== 'claude-result' && turn.usageSource !== 'codex-last-request' || !turn.usage || (turn.usageSource === 'claude-result' ? turn.provider !== 'claude' : turn.provider !== 'codex'))) ||
        (turn.threadUsage !== undefined && (turn.provider !== 'codex' || !validThreadUsage(turn.threadUsage))) ||
        (turn.error !== undefined && typeof turn.error !== 'string') || (turn.permissionDenials !== undefined && (!number(turn.permissionDenials) || !Number.isInteger(turn.permissionDenials))) ||
        (turn.usage !== undefined && (!turn.usage || !number(turn.usage.input) || !number(turn.usage.output) || ['cacheRead', 'cacheCreated', 'estimatedUsd'].some(key => {
          const value = (turn.usage as unknown as Record<string, unknown>)[key]; return value !== undefined && !number(value);
        })))) return true;
      if (turn.modelSettings !== undefined) {
        if (turn.provider !== 'codex') return true;
        validateTurnModelSettings(turn.modelSettings);
      }
      ids.add(turn.id); return false;
    })) throw new Error('Invalid managed session history. Original data retained.');
    for (const turn of data.turns) if (turn.status === 'running') { turn.status = 'interrupted'; turn.error = 'The previous provider process is unavailable. Resume only after checking the task worktree.'; }
    return data;
  }
  save(id: string, view: SessionView): Promise<void> {
    // Pending RPC approvals belong to a live connection and must never survive reload.
    const { approvals: _approvals, active: _active, ...history } = view;
    const directory = this.directory(id), data = JSON.stringify(history, null, 2);
    return this.enqueue(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, data, { flag: 'wx' });
      await replaceAtomic(temporary, path.join(directory, 'history.json'));
    });
  }
  log(id: string, turnId: string, event: unknown): Promise<void> {
    const filename = this.rawPath(id, turnId), data = JSON.stringify(event) + '\n';
    return this.enqueue(async () => { await mkdir(path.dirname(filename), { recursive: true }); await appendFile(filename, data); });
  }
  flush(): Promise<void> { return this.queue; }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation); this.queue = next;
    return next; // A failed raw write poisons the queue: never silently continue a session without its evidence.
  }
}
