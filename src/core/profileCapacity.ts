import { open, readFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type CapacityKind = 'managed' | 'terminal' | 'setup';
interface Lease { version: 1; workspace: string; taskId: string; host: string; token: string; kind: CapacityKind; createdAt: string }
interface Owned { slot: number; lease: Lease }
export interface CapacityView {
  scope: 'profile'; limit: number; reserved: number | null; error?: string;
  owned: Record<string, { kind: CapacityKind; uncertain: boolean }>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const taskId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value);
const workspaceId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const limitValue = (limit: number) => { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error('Profile task capacity must be between one and eight.'); return limit; };

/** Cooperative launch reservations for one local editor profile, not an OS process cap.
 * Recovery callers must hold the existing repository/workspace ownership locks.
 * Never reclaim by age/PID. Per-instance serialization fences duplicate releases.
 */
export class ProfileCapacity {
  private readonly host = randomUUID();
  private readonly owned = new Map<string, Owned>();
  private readonly held = new Set<string>();
  private records: (Lease | undefined)[] = Array(8);
  private problem?: string;
  private loaded = false;
  private operations: Promise<void> = Promise.resolve();
  private watcher?: FSWatcher;
  private disposed = false;
  constructor(readonly directory: string, private readonly workspace: string, private readonly changed: () => void = () => {}) {
    if (!workspaceId(workspace)) throw new Error('Invalid capacity workspace identity.');
  }
  private file(slot: number): string { return path.join(this.directory, `${slot}.json`); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operations.then(action);
    this.operations = result.then(() => {}, () => {}); return result;
  }
  private async read(slot: number): Promise<Lease | undefined> {
    // Exclusive creation briefly exposes an empty file. Retry reads only; never
    // unlink or overwrite another claimant, including malformed/stale records.
    for (const delay of [0, 10, 25, 50, 100]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const file = this.file(slot), info = await lstat(file);
        if (!info.isFile() || info.size > 4096) throw new Error('Invalid profile capacity record. Inspect retained profile storage.');
        const lease = JSON.parse(await readFile(file, 'utf8')) as Lease;
        if (!lease || lease.version !== 1 || !workspaceId(lease.workspace) || !taskId(lease.taskId) || !uuid(lease.host) || !uuid(lease.token) || !['managed', 'terminal', 'setup'].includes(lease.kind) || typeof lease.createdAt !== 'string' || lease.createdAt.length > 60 || !Number.isFinite(Date.parse(lease.createdAt))) throw new Error('Invalid profile capacity record. Inspect retained profile storage.');
        return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (delay === 100) throw new Error('Profile capacity metadata could not be verified. Original data is retained; inspect profile storage before retrying.');
      }
    }
    throw new Error('Profile capacity read failed.');
  }
  private async refreshRecords(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const records = await Promise.all(Array.from({ length: 8 }, (_, slot) => this.read(slot)));
      for (const [id, owner] of this.owned) if (records[owner.slot]?.token !== owner.lease.token) {
        this.held.add(id); throw new Error('An owned profile reservation is missing or replaced. Stop its writer and reconcile explicitly.');
      }
      const seen = new Set<string>();
      for (const [slot, lease] of records.entries()) {
        if (!lease) continue;
        const identity = `${lease.workspace}:${lease.taskId}`;
        if (seen.has(identity)) throw new Error('Duplicate profile task reservations. Retained metadata needs inspection.');
        seen.add(identity);
        if (lease.workspace === this.workspace && !this.owned.has(lease.taskId)) this.owned.set(lease.taskId, { slot, lease });
      }
      this.records = records; this.loaded = true; this.problem = undefined;
    } catch (error) { this.problem = error instanceof Error ? error.message : String(error); throw error; }
  }
  refresh(): Promise<void> { return this.serial(async () => { await this.refreshRecords(); if (!this.disposed) this.changed(); }); }
  startWatching(report: (error: unknown) => void): void {
    if (this.watcher || this.disposed) return;
    this.watcher = watch(this.directory, { persistent: false }, () => { if (!this.disposed) void this.refresh().catch(report); });
    this.watcher.on('error', error => { this.problem = 'Profile capacity watcher failed. Refresh status before launching more work.'; report(error); });
  }
  isUncertain(id: string): boolean { const owner = this.owned.get(id); return !!owner && (owner.lease.host !== this.host || this.held.has(id)); }
  hold(id: string): void { if (this.owned.has(id) && !this.held.has(id)) { this.held.add(id); if (!this.disposed) this.changed(); } }
  view(limit: number): CapacityView {
    return { scope: 'profile', limit: limitValue(limit), reserved: this.loaded && !this.problem ? this.records.filter(Boolean).length : null,
      ...(this.problem ? { error: this.problem } : {}), owned: Object.fromEntries([...this.owned].map(([id, owner]) => [id, { kind: owner.lease.kind, uncertain: this.isUncertain(id) }])) };
  }
  tryAcquire(id: string, kind: CapacityKind, limit: number): Promise<boolean> {
    return this.serial(async () => {
      if (this.disposed || !taskId(id) || !['managed', 'terminal', 'setup'].includes(kind)) throw new Error('Invalid or closed profile capacity request.');
      limitValue(limit); await this.refreshRecords(); if (this.disposed) throw new Error('Profile capacity is closed.');
      const existing = this.owned.get(id);
      if (existing) {
        if (this.isUncertain(id)) throw new Error('Reconcile this uncertain profile writer before starting more work.');
        if (existing.lease.kind !== kind) throw new Error('The task already owns another writer reservation.');
        return true;
      }
      if (this.records.filter(Boolean).length >= limit) return false;
      const lease: Lease = { version: 1, workspace: this.workspace, taskId: id, host: this.host, token: randomUUID(), kind, createdAt: new Date().toISOString() };
      for (let slot = 0; slot < limit; slot++) {
        let handle;
        try { handle = await open(this.file(slot), 'wx'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
        try { await handle.writeFile(JSON.stringify(lease)); await handle.sync(); }
        catch (error) { this.problem = 'Profile reservation could not be saved. Retain the record and inspect storage; no writer was started.'; throw error; }
        finally { await handle.close(); }
        this.owned.set(id, { slot, lease }); this.records[slot] = lease;
        if (!this.disposed) this.changed(); return true;
      }
      await this.refreshRecords(); return false;
    });
  }
  check(id: string, limit: number): Promise<void> {
    return this.serial(async () => {
      await this.refreshRecords(); limitValue(limit);
      if (this.disposed) throw new Error('Profile capacity is closed. No turn submitted.');
      if (!this.owned.has(id) || this.isUncertain(id)) throw new Error('The task has no verified profile writer reservation. No turn submitted.');
      if (this.records.filter(Boolean).length > limit) throw new Error('Profile capacity was reduced during startup. No new turn submitted.');
    });
  }
  release(id: string, acknowledgedAbsence = false): Promise<void> {
    return this.serial(async () => {
      if (this.disposed) throw new Error('Profile capacity is closed. No reservation was released.');
      const owner = this.owned.get(id); if (!owner) return;
      if (this.isUncertain(id) && !acknowledgedAbsence) return;
      try {
        const latest = await this.read(owner.slot);
        if (latest?.token === owner.lease.token) await unlink(this.file(owner.slot));
        else if (!acknowledgedAbsence) throw new Error('Profile reservation ownership changed. No foreign record was released.');
      } catch (error) { this.held.add(id); this.problem = 'Profile reservation cleanup could not be verified. Stop surviving writers and reconcile explicitly.'; if (!this.disposed) this.changed(); throw error; }
      // Acknowledging a missing/replaced reservation forgets only our old claim;
      // it never deletes a new owner's file. Duplicate release now becomes a no-op.
      this.owned.delete(id); this.held.delete(id); await this.refreshRecords(); if (!this.disposed) this.changed();
    });
  }
  async shutdown(): Promise<void> { this.disposed = true; this.watcher?.close(); this.watcher = undefined; await this.operations; }
}
