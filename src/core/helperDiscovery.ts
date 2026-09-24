import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * How a lead's bridge finds its Hydra window. Each window writes one small file
 * (port, lead token, pid, folders) into Hydra's global storage, readable only by
 * this user where the OS supports it, and removes it when the window closes. The
 * bridge matches the folder its CLI runs in (its cwd) against those folders.
 */
export interface HelperWindowRecord { version: 1; port: number; token: string; pid: number; folders: string[]; writtenAt: string }

export const discoveryDirectory = (helpersRoot: string) => path.join(helpersRoot, 'windows');

const normalize = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
async function canonical(value: string): Promise<string> { try { return normalize(await realpath(value)); } catch { return normalize(value); } }

export async function writeWindowRecord(helpersRoot: string, record: Omit<HelperWindowRecord, 'version' | 'writtenAt'>): Promise<string> {
  const directory = discoveryDirectory(helpersRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folders = await Promise.all(record.folders.map(canonical));
  const name = createHash('sha256').update(`${record.pid}\0${folders.join('\0')}`).digest('hex').slice(0, 24);
  const file = path.join(directory, `${name}.json`);
  const body: HelperWindowRecord = { version: 1, port: record.port, token: record.token, pid: record.pid, folders, writtenAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
  return file;
}

export async function removeWindowRecord(file: string): Promise<void> { await rm(file, { force: true }); }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The live window whose folder contains `cwd`; the deepest folder wins. Records of dead windows are removed. */
export async function findWindowFor(helpersRoot: string, cwd: string): Promise<HelperWindowRecord | undefined> {
  const directory = discoveryDirectory(helpersRoot);
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith('.json')); } catch { return undefined; }
  const target = await canonical(cwd);
  let best: { record: HelperWindowRecord; depth: number } | undefined;
  for (const name of names) {
    let record: HelperWindowRecord;
    try { record = JSON.parse(await readFile(path.join(directory, name), 'utf8')); } catch { continue; }
    if (record?.version !== 1 || typeof record.port !== 'number' || typeof record.token !== 'string' || !Array.isArray(record.folders)) continue;
    if (!alive(record.pid)) { await rm(path.join(directory, name), { force: true }).catch(() => {}); continue; }
    for (const folder of record.folders) {
      const relative = path.relative(folder, target);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        if (!best || folder.length > best.depth) best = { record, depth: folder.length };
      }
    }
  }
  return best?.record;
}
