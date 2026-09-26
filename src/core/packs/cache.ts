import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unlinkLinks } from '../laneFinish';
import { packHash, readPackFolder } from './files';
import type { PackRole } from './format';

/**
 * The copies packs run from (docs/Packs_Plan.md, section 4, "Runs from a copy"):
 * `globalStorage/packs/cache/<id>-<hash12>/`. `{pack}`, role files and skill
 * paths all point into the copy, so editing a pack's folder can't change what a
 * running session uses; the next launch sees the new hash instead.
 *
 * A head can write outside its worktree (research R8), so a copy is checked
 * against its hash every time it is used, and rebuilt from the checked bytes
 * when it doesn't match. Copies are written from the bytes the registry read
 * and hashed, never re-read from the pack's folder. Hydra only ever deletes
 * inside the cache folder, and unlinks any link there before deleting.
 */
export const cacheName = (id: string, hash: string): string => `${id}-${hash.slice(0, 12)}`;
/** The plugin folders built for a copy's roles sit beside it: `<id>-<hash12>.plugins/<role>/`. */
export const pluginsName = (id: string, hash: string): string => `${cacheName(id, hash)}.plugins`;

export interface CacheSource { id: string; hash: string; files: ReadonlyMap<string, Uint8Array> }

/** Exported for registry.ts's addUserPack: writing a freshly validated pack's own bytes into a new folder. */
export async function writeFiles(folder: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await mkdir(folder, { recursive: true });
  for (const [name, content] of files) {
    const target = path.join(folder, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
}

/** Remove one entry of the cache folder, and nothing outside it. A link is unlinked, never followed. */
export async function removeCacheEntry(cacheRoot: string, name: string): Promise<void> {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') throw new Error('Hydra only deletes inside its pack cache.');
  const target = path.join(cacheRoot, name);
  const info = await lstat(target).catch(() => undefined);
  if (!info) return;
  const root = await realpath(cacheRoot);
  if (await realpath(path.dirname(target)) !== root) throw new Error('Hydra only deletes inside its pack cache.');
  if (info.isSymbolicLink()) {
    try { await unlink(target); } catch { await rmdir(target); }
    return;
  }
  if (info.isDirectory()) await unlinkLinks(target);
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Whether a folder in the cache holds exactly the files with this hash, and no links. */
export async function copyMatches(folder: string, hash: string): Promise<boolean> {
  try { return (await readPackFolder(folder)).hash === hash; } catch { return false; }
}

// One placement at a time per cache entry in this window: two heads finishing at
// once must not both rebuild a copy, or one could remove the other's while it runs.
const placing = new Map<string, Promise<unknown>>();

/**
 * Put checked bytes in the cache as `name`: written to a fresh temporary
 * folder, checked there, then renamed into place. Another window may finish
 * first; its copy is used when it checks out.
 */
function place(cacheRoot: string, name: string, files: ReadonlyMap<string, Uint8Array>, hash: string): Promise<string> {
  const key = path.join(cacheRoot, name).toLowerCase();
  const next = (placing.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => placeNow(cacheRoot, name, files, hash));
  placing.set(key, next);
  void next.finally(() => { if (placing.get(key) === next) placing.delete(key); }).catch(() => undefined);
  return next;
}
async function placeNow(cacheRoot: string, name: string, files: ReadonlyMap<string, Uint8Array>, hash: string): Promise<string> {
  const final = path.join(cacheRoot, name);
  if (await copyMatches(final, hash)) return final;
  await mkdir(cacheRoot, { recursive: true });
  const temporary = `.tmp-${randomUUID()}`;
  try {
    await writeFiles(path.join(cacheRoot, temporary), files);
    if (!await copyMatches(path.join(cacheRoot, temporary), hash)) throw new Error('Its copy didn\'t match what Hydra checked.');
    // Another window may have placed a good copy meanwhile; only a bad one is replaced.
    if (await copyMatches(final, hash)) return final;
    await removeCacheEntry(cacheRoot, name);
    try { await rename(path.join(cacheRoot, temporary), final); }
    catch (error) { if (!await copyMatches(final, hash)) throw error; }
    return final;
  } finally {
    await removeCacheEntry(cacheRoot, temporary).catch(() => undefined);
  }
}

/** The checked copy of a pack, made or repaired as needed. Its path is what `{pack}` means. */
export async function ensureCached(cacheRoot: string, pack: CacheSource): Promise<string> {
  if (packHash(pack.files) !== pack.hash) throw new Error(`The ${pack.id} pack's files don't match its hash.`);
  return place(cacheRoot, cacheName(pack.id, pack.hash), pack.files, pack.hash);
}

/**
 * A role's Claude plugin (research R5): a folder holding only
 * `.claude-plugin/plugin.json` and the role's own `skills/<id>/` folders,
 * passed with `--plugin-dir`. Nothing else from the pack goes in, so a pack
 * can't add hooks, commands or servers this way. Its skills show as
 * `hydra-<pack>:<skill>`. Building it again gives the same folder.
 */
export async function buildRolePlugin(cacheRoot: string, pack: CacheSource & { title: string }, role: Pick<PackRole, 'id' | 'title' | 'skills'>): Promise<string> {
  const files = new Map<string, Uint8Array>();
  const manifest = { name: `hydra-${pack.id}`, version: `0.0.0-${pack.hash.slice(0, 12)}`, description: `${role.title} skills from the ${pack.title} pack, for Hydra.` };
  files.set('.claude-plugin/plugin.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  for (const [name, content] of pack.files) {
    const [top, skill] = name.split('/');
    if (top === 'skills' && skill && role.skills.includes(skill)) files.set(name, content);
  }
  const folder = path.join(cacheRoot, pluginsName(pack.id, pack.hash));
  await mkdir(folder, { recursive: true });
  return place(folder, role.id, files, packHash(files));
}
