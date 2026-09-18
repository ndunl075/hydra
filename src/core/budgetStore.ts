import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { emptyBudgets, parseBudgets, type BudgetSettings } from './budgets';

/** Separate atomic store: session metadata writes cannot overwrite budget changes. */
export class BudgetStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(): Promise<BudgetSettings> {
    let raw: string;
    try { raw = await readFile(path.join(this.directory, 'budgets.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBudgets(); throw error; }
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || Object.keys(data).some(key => !['version', 'tasks', 'projects'].includes(key))) throw new Error('Unsupported soft budget store. Original data has been retained.');
    const result = emptyBudgets();
    for (const scope of ['tasks', 'projects'] as const) {
      const records = data[scope];
      if (!records || typeof records !== 'object' || Array.isArray(records) || Object.keys(records).length > 10000) throw new Error('Invalid soft budget store. Original data has been retained.');
      for (const [key, value] of Object.entries(records)) {
        if (scope === 'tasks' ? !/^[a-f0-9]{12}$/.test(key) : !path.isAbsolute(key) || key.includes('\0')) throw new Error('Invalid soft budget scope. Original data has been retained.');
        result[scope][key] = parseBudgets(value);
      }
    }
    return result;
  }
  save(settings: BudgetSettings): Promise<void> {
    const data = JSON.stringify({ version: 1, ...settings }, null, 2);
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = path.join(this.directory, `budgets-${randomUUID()}.tmp`);
      await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path.join(this.directory, 'budgets.json'));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

