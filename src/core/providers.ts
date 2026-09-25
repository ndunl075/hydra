import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Provider, ProviderInfo } from './model';
export async function findProvider(provider: Provider, configured?: string): Promise<ProviderInfo> {
  const candidates = configured ? [configured] : (process.env.PATH || '').split(path.delimiter).flatMap(directory =>
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat'].map(extension => path.join(directory, provider + extension)) : [path.join(directory, provider)]);
  if (configured && !path.isAbsolute(configured)) throw new Error(`${provider} path must be absolute.`);
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return { provider, executable: await realpath(candidate), available: true };
    } catch { /* Continue looking; presence never implies authentication. */ }
  }
  return { provider, available: false };
}
/**
 * Identifies one exact binary on disk. Any replacement or in-place update changes
 * its size, modification or change time, so a CLI self-check keyed by this is
 * never reused for a different binary.
 */
export async function executableFingerprint(executable: string): Promise<string> {
  const info = await stat(executable);
  return `${executable}|${info.size}|${info.mtimeMs}|${info.ctimeMs}`;
}
