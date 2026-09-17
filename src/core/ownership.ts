import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class OwnershipLock {
  private readonly token = randomUUID();
  private file?: string;
  async acquire(directory: string, identity: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const normalized = process.platform === 'win32' ? identity.toLowerCase() : identity;
    const file = path.join(directory, `${createHash('sha256').update(normalized).digest('hex')}.json`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(file, JSON.stringify({ pid: process.pid, token: this.token }), { flag: 'wx' });
        this.file = file;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = JSON.parse(await readFile(file, 'utf8')) as { pid: number };
        if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0) throw new Error('Invalid ownership lock; inspect the Hydra storage directory.');
        try { process.kill(existing.pid, 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH') {
            // Serialize stale-lock reclamation so two recovering windows cannot delete each other's new lock.
            const reclaim = `${file}.reclaim`;
            await writeFile(reclaim, this.token, { flag: 'wx' }).catch(() => { throw new Error('Workspace recovery is locked. If no other window is recovering, inspect the Hydra ownership directory before retrying.'); });
            try {
              const latest = JSON.parse(await readFile(file, 'utf8')) as { pid: number };
              try { process.kill(latest.pid, 0); }
              catch (check) {
                if ((check as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(file); continue; }
                throw check;
              }
              throw new Error('Workspace ownership changed during recovery. Use its owning window.');
            } finally { await unlink(reclaim); }
          }
          throw failure;
        }
        throw new Error('This workspace is already managed in another VS Code window. Use that window, or close it before launching Hydra here.');
      }
    }
    throw new Error('Could not acquire workspace ownership.');
  }
  async release(): Promise<void> {
    if (!this.file) return;
    try {
      const owner = JSON.parse(await readFile(this.file, 'utf8')) as { token: string };
      if (owner.token === this.token) await unlink(this.file);
      this.file = undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
