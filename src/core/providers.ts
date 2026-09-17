import { access, realpath } from 'node:fs/promises';
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
export function terminalLaunch(executable: string): { shellPath: string; shellArgs: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const script = `& '${executable.replace(/'/g, "''")}'`;
    const shellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { shellPath, shellArgs: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  return { shellPath: executable, shellArgs: [] };
}
