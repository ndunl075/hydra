import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { packCaps } from './format';

/**
 * Reading a pack folder safely (docs/Packs_Plan.md, sections 2 and 4). A pack
 * with a junction or symbolic link anywhere in it is refused (the 2026-09-24
 * lesson), and so is anything that isn't a plain file or folder. The folder is
 * read once, into memory (a pack is at most 4 MB); the checks, the hash and the
 * cached copy all use those same bytes, so what was checked is what runs.
 */
export interface PackFiles {
  /** Each file's path in the pack, with forward slashes, and its bytes. */
  files: Map<string, Buffer>;
  hash: string;
}

const byCodeUnit = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * The pack's content hash: SHA-256 over its files in sorted path order, each as
 * its path, its length and its bytes. Any change to any file, name or content,
 * changes it; the order files were read in doesn't.
 */
export function packHash(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash('sha256').update('hydra-pack-1\n');
  for (const name of [...files.keys()].sort(byCodeUnit)) {
    const content = files.get(name)!;
    hash.update(`${name}\n${content.byteLength}\n`);
    hash.update(content);
  }
  return hash.digest('hex');
}

/** Read every file of a pack folder, refusing links, special files and anything past the caps. */
export async function readPackFolder(folder: string): Promise<PackFiles> {
  const top = await lstat(folder).catch(() => undefined);
  if (!top) throw new Error('The folder doesn\'t exist.');
  if (top.isSymbolicLink()) throw new Error('The folder is a link (a junction or symbolic link). Packs can\'t be links.');
  if (!top.isDirectory()) throw new Error('It isn\'t a folder.');
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > packCaps.depth) throw new Error(`"${relative}" is nested too deep (at most ${packCaps.depth} folders).`);
    const entries = await readdir(relative ? path.join(folder, ...relative.split('/')) : folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(folder, ...name.split('/'));
      const info = await lstat(full);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) throw new Error(`"${name}" is a link (a junction or symbolic link). Packs can't contain links.`);
      if (info.isDirectory()) { await visit(name, depth + 1); continue; }
      if (!info.isFile()) throw new Error(`"${name}" isn't a plain file or folder.`);
      if (files.size >= packCaps.files) throw new Error(`A pack has at most ${packCaps.files} files.`);
      if (bytes + info.size > packCaps.bytes) throw new Error(`A pack is at most ${packCaps.bytes / 1024 / 1024} MB.`);
      const content = await readFile(full);
      bytes += content.byteLength;
      if (bytes > packCaps.bytes) throw new Error(`A pack is at most ${packCaps.bytes / 1024 / 1024} MB.`);
      files.set(name, content);
    }
  };
  await visit('', 0);
  return { files, hash: packHash(files) };
}
