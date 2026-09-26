import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from '../atomicFile';
import type { InstalledPack, PackSource } from './registry';

/**
 * What you allowed on this machine (docs/Packs_Plan.md, section 4):
 * `globalStorage/packs/allowed.json`, one entry per project and pack.
 *
 * `.hydra/packs.json` says what a project wants; this record says what you
 * agreed to run. Only the extension writes it, and only when you press the
 * button at the end of a pack's review panel. A repository can't write it: it
 * lives in Hydra's global storage, keyed by the project's canonical path.
 *
 * - A built-in pack is pinned to Hydra: an update doesn't ask again (decision 2
 *   still asks once per project).
 * - Your packs and the project's are pinned to their content hash: any change
 *   to any file makes them Changed until you review them again.
 */
export interface AllowedEntry {
  /** The project's canonical path (canonicalProject). */
  project: string;
  pack: string;
  source: PackSource;
  /** The content hash you allowed, for a pack that isn't built in. */
  hash?: string;
  /** The Hydra version it was allowed in, for "Updated in Hydra x.y". */
  version?: string;
  at: string;
}
export interface AllowedRecord {
  entries: AllowedEntry[];
  /** Why the record couldn't be read. Nothing counts as allowed then. */
  problem?: string;
}

/** A project's key in the record: its real path, lower-cased on Windows. */
export async function canonicalProject(folder: string): Promise<string> {
  const resolved = await realpath(folder).catch(() => path.resolve(folder));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const sources: readonly PackSource[] = ['builtin', 'user', 'project'];
function validEntry(value: unknown): value is AllowedEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.project === 'string' && !!entry.project && typeof entry.pack === 'string' && !!entry.pack
    && sources.includes(entry.source as PackSource) && typeof entry.at === 'string'
    && (entry.hash === undefined || (typeof entry.hash === 'string' && /^[a-f0-9]{64}$/.test(entry.hash)))
    && (entry.version === undefined || typeof entry.version === 'string')
    && (entry.source === 'builtin' || typeof entry.hash === 'string');
}

/** The record. A missing file allows nothing; an unreadable one allows nothing and says why. Entries that don't check out are ignored. */
export async function readAllowed(file: string): Promise<AllowedRecord> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { entries: [] } : { entries: [], problem: `Hydra couldn't read what you allowed on this machine (${(error as Error).message}).` }; }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('it isn\'t a version 1 record');
    return { entries: parsed.entries.filter(validEntry) };
  } catch (error) {
    return { entries: [], problem: `Hydra couldn't read what you allowed on this machine (${error instanceof Error ? error.message : String(error)}).` };
  }
}

export type AllowState = { state: 'allowed'; note?: string } | { state: 'needsOk' | 'changed'; reason: string };
/**
 * Whether you allowed this pack for this project. A pack from another source
 * than the one allowed (say, a project pack now used instead of yours) needs
 * your OK again, as does a pack that isn't built in whose hash changed.
 */
export function allowState(record: AllowedRecord, project: string, pack: Pick<InstalledPack, 'id' | 'source' | 'hash'>, title: string, version?: string): AllowState {
  const needsOk = { state: 'needsOk' as const, reason: record.problem ?? `The ${title} pack isn't allowed on this machine yet.` };
  const entry = record.entries.find(candidate => candidate.project === project && candidate.pack === pack.id);
  if (!entry || entry.source !== pack.source) return needsOk;
  if (pack.source === 'builtin') return entry.version && version && entry.version !== version ? { state: 'allowed', note: `Updated in Hydra ${version}.` } : { state: 'allowed' };
  if (!pack.hash || entry.hash !== pack.hash) return { state: 'changed', reason: `The ${title} pack changed since you allowed it. Review it again in Settings → Packs.` };
  return { state: 'allowed' };
}

// Writes from this window go one at a time, so two quick allows can't lose one another.
const queues = new Map<string, Promise<unknown>>();
function queued<T>(file: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(file, next);
  return next;
}
async function writeRecord(file: string, entries: AllowedEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await replaceAtomic(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/**
 * Record your OK for a pack in a project, replacing any earlier entry for that
 * pair. Call this only from the review panel's button: it is what lets the
 * pack's gates and servers run.
 */
export function allowPack(file: string, project: string, pack: Pick<InstalledPack, 'id' | 'source' | 'hash'>, version: string, now = new Date()): Promise<void> {
  if (pack.source !== 'builtin' && !pack.hash) return Promise.reject(new Error(`The ${pack.id} pack couldn't be read, so it can't be allowed.`));
  return queued(file, async () => {
    const record = await readAllowed(file);
    if (record.problem) throw new Error(record.problem);
    const entry: AllowedEntry = { project, pack: pack.id, source: pack.source, ...(pack.source !== 'builtin' ? { hash: pack.hash } : {}), version, at: now.toISOString() };
    await writeRecord(file, [...record.entries.filter(other => !(other.project === project && other.pack === pack.id)), entry]);
  });
}

/** Forget your OK for a pack in a project (turning it off keeps the OK; this is for "Forget"). */
export function revokePack(file: string, project: string, id: string): Promise<void> {
  return queued(file, async () => {
    const record = await readAllowed(file);
    if (record.problem) throw new Error(record.problem);
    const entries = record.entries.filter(other => !(other.project === project && other.pack === id));
    if (entries.length !== record.entries.length) await writeRecord(file, entries);
  });
}
