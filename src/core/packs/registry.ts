import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkPackContents, packIdPattern, parsePackManifest, type ValidPack } from './format';
import { readPackFolder } from './files';

/**
 * Where packs come from (docs/Packs_Plan.md, section 2, and decision 1):
 *
 * - **Built in:** `<extensionPath>/packs/<id>/`, shipped with this Hydra.
 * - **Yours:** `~/.hydra/packs/<id>/`, or the folder `hydra.packs.folder` names.
 * - **The project's:** `<lead folder>/.hydra/packs/<id>/`, read from the lead's
 *   folder only, never a worktree.
 *
 * Your packs and the project's are third-party: pinned by content hash and
 * reviewed before anything runs (allowed.ts). Each folder is read, validated
 * and hashed on its own, so a broken pack is listed with its problem and never
 * breaks the others.
 */
export type PackSource = 'builtin' | 'user' | 'project';
export interface PackRoots {
  builtin?: string;
  user?: string;
  /** The lead folder's `.hydra/packs`. */
  project?: string;
}

export interface InstalledPack {
  /** The folder's name, which is the pack's id when it is valid. */
  id: string;
  source: PackSource;
  folder: string;
  /** Present when the pack is valid. */
  valid?: ValidPack;
  /** Present when the folder could be read. */
  hash?: string;
  /** The files as read and hashed; the cached copy is written from these same bytes. */
  files?: ReadonlyMap<string, Buffer>;
  /** Why it can't be turned on. */
  problem?: string;
  /** Something to show without blocking it, like another pack with the same id being used instead. */
  note?: string;
}

export const sourceLabel: Readonly<Record<PackSource, string>> = { builtin: 'Built into Hydra', user: 'Your packs folder', project: 'This project' };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Read, validate and hash one pack folder. Never throws: a problem is returned on the pack. */
export async function loadPack(folder: string, source: PackSource): Promise<InstalledPack> {
  const id = path.basename(folder);
  const base: InstalledPack = { id, source, folder };
  if (!packIdPattern.test(id)) return { ...base, problem: 'The folder\'s name must be the pack\'s id: 1–24 lowercase letters, digits or dashes.' };
  let read;
  try { read = await readPackFolder(folder); } catch (error) { return { ...base, problem: message(error) }; }
  const withFiles: InstalledPack = { ...base, hash: read.hash, files: read.files };
  const raw = read.files.get('pack.json');
  if (!raw) return { ...withFiles, problem: 'It has no pack.json.' };
  let json: unknown;
  try { json = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch (error) { return { ...withFiles, problem: `pack.json isn't valid JSON: ${message(error)}` }; }
  try {
    const manifest = parsePackManifest(json);
    if (manifest.id !== id) return { ...withFiles, problem: `Its pack.json says the id is "${manifest.id}", but the folder is named "${id}". They must match.` };
    return { ...withFiles, valid: checkPackContents(manifest, read.files) };
  } catch (error) {
    return { ...withFiles, problem: message(error) };
  }
}

/** The pack folders under one root. A missing or unreadable root has none; dot-folders (like .git) are skipped. */
async function packFolders(root: string | undefined): Promise<string[]> {
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.')).map(entry => path.join(root, entry.name)).sort();
}

/**
 * Every pack under the roots: built-in first, then yours, then the project's.
 * `only` limits the reading and hashing to those ids, for the gates loader,
 * which needs only the packs a project lists.
 *
 * Ids are settled here: a pack of yours or the project's can't reuse a
 * built-in id, and a project pack wins over one of yours with the same id,
 * since it is what the project ships. The one not used is listed with why.
 */
export async function listPacks(roots: PackRoots, options: { only?: ReadonlySet<string> } = {}): Promise<InstalledPack[]> {
  const wanted = (folder: string) => !options.only || options.only.has(path.basename(folder));
  const packs: InstalledPack[] = [];
  for (const source of ['builtin', 'user', 'project'] as const) {
    for (const folder of (await packFolders(roots[source])).filter(wanted)) packs.push(await loadPack(folder, source));
  }
  const builtIn = new Set(packs.filter(pack => pack.source === 'builtin').map(pack => pack.id));
  const projects = new Set(packs.filter(pack => pack.source === 'project' && !builtIn.has(pack.id)).map(pack => pack.id));
  return packs.map(pack => {
    if (pack.source !== 'builtin' && builtIn.has(pack.id)) return { ...pack, valid: undefined, problem: `${pack.id} is a built-in pack; choose another id.` };
    if (pack.source === 'user' && projects.has(pack.id)) return { ...pack, note: `This project has its own ${pack.id} pack, which it uses instead.` };
    return pack;
  });
}

/** The pack a project gets for an id: built in, else the project's own, else yours. Undefined when none is installed. */
export function choosePack(packs: readonly InstalledPack[], id: string): InstalledPack | undefined {
  for (const source of ['builtin', 'project', 'user'] as const) {
    const pack = packs.find(candidate => candidate.id === id && candidate.source === source);
    if (pack) return pack;
  }
  return undefined;
}
