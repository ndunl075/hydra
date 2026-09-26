import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from '../atomicFile';
import { allowState, canonicalProject, readAllowed } from './allowed';
import { ensureCached } from './cache';
import { formatPacksFile, parsePacksFile, skipGatesProblem, type PacksFile, type PacksFileEntry } from './format';
import { choosePack, listPacks, type InstalledPack, type PackRoots } from './registry';

/**
 * A project's packs (docs/Packs_Plan.md, section 3). `.hydra/packs.json` in the
 * lead folder says which packs the project wants, in order; it is read from the
 * lead's folder only, never a worktree, so a head can't turn a pack on or off.
 *
 * A pack is **active** (On) when packs.json lists it, it is installed, it is
 * valid, and you allowed it here (for a pack that isn't built in, with the same
 * content hash). Only then does anything from it run, from its checked copy.
 */
export const packsFile = (folder: string): string => path.join(folder, '.hydra', 'packs.json');
export const projectPacksFolder = (folder: string): string => path.join(folder, '.hydra', 'packs');

/** packs.json, or an empty list when the project has none. Throws the problem when it can't be used: a typo never silently turns packs off. */
export async function readPacksFile(folder: string): Promise<{ file: PacksFile; exists: boolean }> {
  let raw: string;
  try { raw = (await readFile(packsFile(folder), 'utf8')).replace(/^﻿/, ''); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: { version: 1, packs: [] }, exists: false };
    throw new Error(`.hydra/packs.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`.hydra/packs.json isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return { file: parsePacksFile(parsed), exists: true };
}

/** Write packs.json atomically, as 2-space JSON with a trailing newline. */
export async function writePacksFile(folder: string, file: PacksFile): Promise<void> {
  const target = packsFile(folder);
  let text = formatPacksFile(parsePacksFile(JSON.parse(formatPacksFile(file))));
  // A committed file checked out with CRLF keeps its line endings, and one that already says this
  // isn't written again, so turning on a pack a teammate listed leaves the checkout clean.
  const current = await readFile(target, 'utf8').catch(() => undefined);
  if (current !== undefined) {
    if (current.replace(/^﻿/, '').replace(/\r\n/g, '\n') === text) return;
    if (current.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try { await replaceAtomic(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The file with a pack turned on (added at the end) or off (removed). */
export function withPack(file: PacksFile, id: string, on: boolean): PacksFile {
  const listed = file.packs.some(entry => entry.id === id);
  if (on) return listed ? file : { version: 1, packs: [...file.packs, { id }] };
  return { version: 1, packs: file.packs.filter(entry => entry.id !== id) };
}
/** The file with one of a pack's gates skipped in this project, or no longer skipped. */
export function withSkipGate(file: PacksFile, id: string, gate: string, skip: boolean): PacksFile {
  if (!file.packs.some(entry => entry.id === id)) throw new Error(`The ${id} pack isn't on in this project.`);
  return {
    version: 1,
    packs: file.packs.map(entry => {
      if (entry.id !== id) return entry;
      const others = (entry.skipGates ?? []).filter(other => other !== gate);
      const skipGates = skip ? [...others, gate] : others;
      return { id: entry.id, ...(skipGates.length ? { skipGates } : {}) };
    }),
  };
}

// ---- Each pack's state in a project ----

export type PackState = 'off' | 'on' | 'needsOk' | 'changed' | 'notInstalled' | 'invalid';
export interface ProjectPack {
  id: string;
  /** The pack's title, or its id when it can't be read. */
  title: string;
  state: PackState;
  /** Why it isn't on, in plain English. Also the "not run" reason for its gates. */
  reason?: string;
  /** Its packs.json entry, when the project lists it. */
  entry?: PacksFileEntry;
  pack?: InstalledPack;
  /** The checked copy it runs from: what `{pack}` means. Only when it is on. */
  copy?: string;
  /** Things to show without blocking it: "Updated in Hydra 0.25.", a skipGates typo. */
  notes: string[];
}

/** Where a window's packs live: the built-in and user roots, and its global storage. */
export interface PackPlaces {
  builtin?: string;
  user?: string;
  /** `globalStorage/packs/allowed.json`. */
  allowedFile: string;
  /** `globalStorage/packs/cache`. */
  cacheRoot: string;
  /** This Hydra's version, for built-in packs. */
  version: string;
}

export const packTitle = (id: string, pack?: InstalledPack): string => pack?.valid?.manifest.title ?? id;

/**
 * Every pack's state in a project: the listed packs in packs.json order, then
 * (unless `listedOnly`) the installed packs it doesn't list, as Off. A listed
 * pack that is on gets its checked copy made or repaired here.
 */
export async function projectPacks(folder: string, places: PackPlaces, options: { listedOnly?: boolean } = {}): Promise<{ file: PacksFile; exists: boolean; packs: ProjectPack[] }> {
  const { file, exists } = await readPacksFile(folder);
  const roots: PackRoots = { builtin: places.builtin, user: places.user, project: projectPacksFolder(folder) };
  const installed = await listPacks(roots, options.listedOnly ? { only: new Set(file.packs.map(entry => entry.id)) } : {});
  const project = await canonicalProject(folder);
  const allowed = file.packs.length ? await readAllowed(places.allowedFile) : { entries: [] };
  const packs: ProjectPack[] = [];
  for (const entry of file.packs) {
    const pack = choosePack(installed, entry.id);
    const title = packTitle(entry.id, pack);
    if (!pack) { packs.push({ id: entry.id, title, state: 'notInstalled', entry, notes: [], reason: `The ${entry.id} pack isn't installed: it's neither built into Hydra nor in your packs folder.` }); continue; }
    if (!pack.valid || !pack.hash || !pack.files) { packs.push({ id: entry.id, title, state: 'invalid', entry, pack, notes: [], reason: `The ${title} pack has a problem: ${pack.problem ?? 'it couldn\'t be read.'}` }); continue; }
    const notes = [pack.note, skipGatesProblem(entry, pack.valid.manifest)].filter((note): note is string => !!note);
    const allow = allowState(allowed, project, pack, title, places.version);
    if (allow.state !== 'allowed') { packs.push({ id: entry.id, title, state: allow.state, entry, pack, notes, reason: allow.reason }); continue; }
    if (allow.note) notes.push(allow.note);
    try {
      const copy = await ensureCached(places.cacheRoot, { id: pack.id, hash: pack.hash, files: pack.files });
      packs.push({ id: entry.id, title, state: 'on', entry, pack, copy, notes });
    } catch (error) {
      packs.push({ id: entry.id, title, state: 'invalid', entry, pack, notes, reason: `Hydra couldn't prepare the ${title} pack's copy: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (!options.listedOnly) {
    const listed = new Set(file.packs.map(entry => entry.id));
    for (const pack of installed) {
      if (listed.has(pack.id) && choosePack(installed, pack.id) === pack) continue;
      packs.push({ id: pack.id, title: packTitle(pack.id, pack), state: pack.valid ? 'off' : 'invalid', pack, notes: pack.note ? [pack.note] : [], ...(pack.problem ? { reason: pack.problem } : {}) });
    }
  }
  return { file, exists, packs };
}

/** Only the packs that are on, in packs.json order. */
export async function activePacks(folder: string, places: PackPlaces): Promise<ProjectPack[]> {
  return (await projectPacks(folder, places, { listedOnly: true })).packs.filter(pack => pack.state === 'on');
}
