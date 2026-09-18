import { mkdir, readFile, writeFile, unlink, appendFile, realpath, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { parseResources, resourceKeys, resourceEnvironment, resolveSetupCommands, type ResourceConfig, type ResourceRecord, type ResourceView } from './resourceModel';
import { runSetupCommand } from './setupProcess';
const idPattern = /^[a-f0-9]{12}$/;
const emptyConfig = (): ResourceConfig => ({ commands: [], timeoutMs: 120000 });
type Active = { controller: AbortController; done: Promise<void> };
/** Persistent logical reservations across Hydra windows in the same local profile. */
export class TaskResources {
  private records: Record<string, ResourceRecord> = {};
  private active = new Map<string, Active>();
  private mutations = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly reservations: string, private readonly owner: string, private readonly changed: () => void = () => {}, private readonly report: (error: unknown) => void = () => {}) {}
  private id(id: string): void { if (!idPattern.test(id)) throw new Error('Invalid task ID.'); }
  private claimFile(key: string): string { return path.join(this.reservations, createHash('sha256').update(key).digest('hex') + '.json'); }
  private ownership(id: string): string { return `${this.owner}:${id}`; }
  private async claim(key: string): Promise<{ owner: string; token: string }> {
    const raw = await readFile(this.claimFile(key), 'utf8'); if (raw.length > 4096) throw new Error('Invalid resource reservation.');
    const value = JSON.parse(raw); if (!value || typeof value.owner !== 'string' || typeof value.token !== 'string') throw new Error('Invalid resource reservation.'); return value;
  }
  private async releaseKey(id: string, key: string, token: string): Promise<void> {
    try { const claim = await this.claim(key); if (claim.owner !== this.ownership(id) || claim.token !== token) throw new Error('Resource reservation ownership changed; nothing released.'); await unlink(this.claimFile(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, records: this.records }, null, 2);
    const next = this.queue.then(async () => { await mkdir(this.directory, { recursive: true }); const temporary = path.join(this.directory, `resources-${randomUUID()}.tmp`); await writeFile(temporary, data, { flag: 'wx' }); await replaceAtomic(temporary, path.join(this.directory, 'resources.json')); });
    this.queue = next.catch(() => {}); return next;
  }
  async load(): Promise<void> {
    let raw: string; try { raw = await readFile(path.join(this.directory, 'resources.json'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const data = JSON.parse(raw); if (!data || data.version !== 1 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records) || Object.keys(data.records).length > 10000) throw new Error('Invalid task resource store. Original data retained.');
    const records: Record<string, ResourceRecord> = {};
    for (const [id, value] of Object.entries(data.records)) {
      this.id(id); const record = value as ResourceRecord;
      if (!record || typeof record !== 'object' || !/^[a-f0-9-]{36}$/.test(record.token) || !/^[a-f0-9-]{36}$/.test(record.revision) || typeof record.reserved !== 'boolean' || !['unchecked', 'running', 'passed', 'failed', 'interrupted', 'released'].includes(record.status) || record.uncertain !== undefined && typeof record.uncertain !== 'boolean' || !Array.isArray(record.checks) || record.checks.length > 10 || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('Invalid task resource record. Original data retained.');
      record.config = parseResources(record.config);
      for (const check of record.checks) { parseResources({ commands: [{ executable: check.executable, args: check.args }] }); if (!['running', 'passed', 'failed'].includes(check.status) || typeof check.stdout !== 'string' || typeof check.stderr !== 'string' || check.stdout.length > 16000 || check.stderr.length > 16000 || check.error !== undefined && (typeof check.error !== 'string' || check.error.length > 4000) || check.exitCode !== undefined && check.exitCode !== null && !Number.isSafeInteger(check.exitCode)) throw new Error('Invalid setup evidence. Original data retained.'); }
      if (record.log && (!path.isAbsolute(record.log) || path.dirname(path.resolve(record.log)) !== path.resolve(this.directory, 'setups', id) || !/^[a-f0-9-]{36}\.jsonl$/.test(path.basename(record.log)))) throw new Error('Invalid setup log path. Original data retained.');
      if (record.status === 'passed' && (record.checks.length !== record.config.commands.length || record.checks.some(check => check.status !== 'passed' || check.exitCode !== 0 || check.error))) throw new Error('Incomplete setup evidence. Original data retained.');
      if (record.status === 'running') { record.status = 'interrupted'; record.uncertain = true; }
      records[id] = record;
    }
    this.records = records; await this.save();
  }
  snapshot(): Record<string, ResourceView> { return Object.fromEntries(Object.entries(this.records).map(([id, { token: _token, revision: _revision, ...view }]) => [id, structuredClone(view)])); }
  isActive(id: string): boolean { return this.active.has(id) || this.mutations.has(id); }
  has(id: string): boolean { return this.active.has(id) || this.mutations.has(id) || !!this.records[id]?.uncertain; }
  get count(): number { return this.active.size + Object.values(this.records).filter(record => record.uncertain).length; }
  environment(id: string): Record<string, string> { return this.records[id] ? resourceEnvironment(this.records[id].config) : {}; }
  assertReady(id: string): void {
    const record = this.records[id]; if (this.has(id)) throw new Error('Stop setup and reconcile its writer before launching this task.');
    if (!record) return;
    if (!record.reserved) throw new Error('Reacquire the saved task resources before launching.');
    if (record.config.commands.length && record.status !== 'passed') throw new Error('Run the saved setup commands successfully before launching this task.');
  }
  async check(id: string): Promise<void> {
    this.assertReady(id); const record = this.records[id]; if (!record) return;
    for (const key of resourceKeys(record.config)) { const claim = await this.claim(key); if (claim.owner !== this.ownership(id) || claim.token !== record.token) throw new Error('Task resource reservation is unavailable or changed.'); }
    this.assertReady(id);
  }
  async configure(id: string, configValue: unknown): Promise<void> {
    this.id(id); if (this.has(id)) throw new Error('Stop and reconcile setup before changing resources.');
    const config = parseResources(configValue); resolveSetupCommands(config); this.mutations.add(id);
    let previous = this.records[id]; const acquired: string[] = [];
    try {
      if (!previous) { previous = { config: emptyConfig(), token: randomUUID(), revision: randomUUID(), reserved: false, status: 'released', checks: [], updatedAt: new Date().toISOString() }; this.records[id] = previous; try { await this.save(); } catch (error) { delete this.records[id]; throw error; } }
      await mkdir(this.reservations, { recursive: true });
      for (const key of resourceKeys(config)) {
        try {
          await writeFile(this.claimFile(key), JSON.stringify({ owner: this.ownership(id), token: previous.token }), { flag: 'wx' }); acquired.push(key);
          if (key.startsWith('port:')) await new Promise<void>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen({ port: config.port, host: '127.0.0.1', exclusive: true }, () => server.close(error => error ? reject(error) : resolve())); });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const claim = await this.claim(key); if (claim.owner !== this.ownership(id) || claim.token !== previous.token) throw new Error(`${key} is already reserved by another Hydra task.`);
        }
      }
      const candidate: ResourceRecord = { config, token: previous.token, revision: randomUUID(), reserved: true, status: 'unchecked', checks: [], updatedAt: new Date().toISOString() };
      this.records[id] = candidate;
      try { await this.save(); } catch (error) { this.records[id] = previous; throw error; }
      acquired.length = 0; // The durable candidate now owns every claim.
      for (const key of resourceKeys(previous.config).filter(key => !resourceKeys(config).includes(key))) await this.releaseKey(id, key, previous.token);
    } catch (error) { for (const key of acquired) await this.releaseKey(id, key, this.records[id]!.token); throw error; }
    finally { this.mutations.delete(id); this.changed(); }
  }
  async release(id: string): Promise<void> {
    this.id(id); if (this.has(id)) throw new Error('Stop and reconcile setup before releasing resources.'); const record = this.records[id]; if (!record) return;
    this.mutations.add(id); try { record.reserved = false; record.status = 'released'; record.updatedAt = new Date().toISOString(); await this.save();
      // Explicit release also cleans a previous owned claim retained by a failed configuration cleanup.
      for (const file of await readdir(this.reservations).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        const location = path.join(this.reservations, file), claim = JSON.parse(await readFile(location, 'utf8'));
        if (claim.owner === this.ownership(id) && claim.token === record.token) await unlink(location);
      }
    }
    finally { this.mutations.delete(id); this.changed(); }
  }
  async reacquire(id: string): Promise<void> { const record = this.records[id]; if (!record) throw new Error('No saved task resources.'); await this.configure(id, record.config); }
  async invalidate(id: string): Promise<void> {
    const record = this.records[id]; if (!record?.config.commands.length) return;
    if (this.has(id)) throw new Error('Stop setup before changing its dependency base.');
    this.mutations.add(id); const previous = structuredClone(record);
    try { record.status = 'unchecked'; record.updatedAt = new Date().toISOString(); await this.save(); }
    catch (error) { this.records[id] = previous; throw error; }
    finally { this.mutations.delete(id); this.changed(); }
  }
  async reconcile(id: string): Promise<void> { const record = this.records[id]; if (!record?.uncertain || this.active.has(id)) throw new Error('Stop the active setup process first.'); const previous = structuredClone(record); record.uncertain = false; record.status = 'interrupted'; try { await this.save(); } catch (error) { this.records[id] = previous; throw error; } this.changed(); }
  async start(id: string, cwd: string, guard: () => Promise<void>): Promise<void> {
    this.id(id); if (this.has(id)) throw new Error('Setup already active or uncertain.'); const record = this.records[id]; if (!record?.config.commands.length) throw new Error('Save explicit setup commands first.');
    if (!record.reserved) throw new Error('Reacquire resources before setup.');
    const controller = new AbortController(); let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); this.active.set(id, { controller, done });
    try {
      await guard(); for (const key of resourceKeys(record.config)) { const claim = await this.claim(key); if (claim.owner !== this.ownership(id) || claim.token !== record.token) throw new Error('Task resource reservation changed.'); }
      const commands = resolveSetupCommands(record.config); const directory = path.join(this.directory, 'setups', id); await mkdir(directory, { recursive: true });
      record.log = path.join(directory, randomUUID() + '.jsonl'); record.status = 'running'; record.checks = []; record.updatedAt = new Date().toISOString(); await this.save();
      void (async () => {
        try {
          let remaining = 1024 * 1024;
          for (const command of commands) {
            if (controller.signal.aborted) throw new Error('Setup cancelled.'); await guard();
            const check = { ...command, status: 'running' as const, stdout: '', stderr: '' }; record.checks.push(check); await this.save(); this.changed();
            const output = await runSetupCommand(command, await realpath(cwd), resourceEnvironment(record.config), controller.signal, record.config.timeoutMs, remaining);
            remaining = Math.max(0, remaining - Buffer.byteLength(output.stdout) - Buffer.byteLength(output.stderr));
            if (output.uncertain) record.uncertain = true;
            await appendFile(record.log!, JSON.stringify({ at: new Date().toISOString(), command, cwd, environment: resourceEnvironment(record.config), ...output }) + '\n');
            Object.assign(check, { ...output, ...(output.error ? { error: output.error.slice(0, 4000) } : {}), stdout: output.stdout.slice(0, 16000), stderr: output.stderr.slice(0, 16000), status: !output.error && output.exitCode === 0 ? 'passed' : 'failed' });
            if (output.error || output.exitCode !== 0) throw new Error(output.error || `Setup exited ${output.exitCode}.`);
            await this.save();
          }
          record.status = 'passed';
        } catch (error) { record.status = controller.signal.aborted ? 'interrupted' : 'failed'; this.report(error); }
        finally {
          record.updatedAt = new Date().toISOString(); try { await this.save(); } catch (error) { record.status = 'interrupted'; record.uncertain = true; this.report(error); }
          this.active.delete(id); finish(); this.changed();
        }
      })();
    } catch (error) { record.status = 'failed'; record.updatedAt = new Date().toISOString(); this.active.delete(id); finish(); this.changed(); throw error; }
    this.changed();
  }
  async stop(id: string): Promise<void> { const active = this.active.get(id); active?.controller.abort(); await active?.done; }
  async finished(id: string): Promise<void> { await this.active.get(id)?.done; }
  async shutdown(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.stop(id))); await this.queue; }
}
