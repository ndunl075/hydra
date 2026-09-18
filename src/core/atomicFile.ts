import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Preserve atomic replacement while allowing short Windows reader/share locks to clear. */
export async function replaceAtomic(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt >= 7) throw error;
      await delay(Math.min(25 * 2 ** attempt, 250));
    }
  }
}
