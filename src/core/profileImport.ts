import { readFile, writeFile, mkdir, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
// Bundle the ESM entry; the UMD entry uses dynamic requires that cannot be inlined.
import { parseTree, getNodeValue, modify, applyEdits, type Node, type ParseError } from 'jsonc-parser/lib/esm/main';
import { OwnershipLock } from './ownership';

export type ImportCategory = 'settings' | 'keybindings' | 'snippets';
export interface ProfileResources { id: string; name: string; root: string; settings: string; keybindings: string; snippets: string }
export interface ImportOptions { knownSettings: readonly string[]; themes: readonly string[]; commands: readonly string[]; languages: readonly string[] }
export interface ImportItem { category: ImportCategory; name: string; state: 'add' | 'conflict' | 'skip'; detail?: string }
interface Snapshot { file: string; bytes: Buffer | null }
interface Change extends Snapshot { category: ImportCategory; after: Buffer }
export interface ImportPlan { token: string; source: string; profile: ProfileResources; items: ImportItem[]; warnings: string[]; inputs: Snapshot[]; changes: Change[] }
interface Journal { version: 1; profile: ProfileResources; state: 'prepared' | 'applied' | 'undone'; files: { file: string; category: ImportCategory; before: string | null; afterHash: string }[] }
const categories: ImportCategory[] = ['settings', 'keybindings', 'snippets'];
const maxFile = 1024 * 1024;
const hash = (bytes: Buffer | null) => bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex');
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export const profileIdentity = (profile: ProfileResources) => JSON.stringify([profile.id, profile.root, profile.settings, profile.keybindings, profile.snippets]);
export function detectedImportFolder(provider: 'vscode' | 'cursor', appData: string): string {
  if (!path.isAbsolute(appData) || !['vscode', 'cursor'].includes(provider)) throw new Error('Could not locate the Windows user settings folder. Choose a folder instead.');
  return path.join(appData, provider === 'vscode' ? 'Code' : 'Cursor', 'User');
}

async function safePath(root: string, file: string): Promise<void> {
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !inside(root, file)) throw new Error('Preference path escapes its profile.');
  const canonicalRoot = await realpath(root);
  let current = root;
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !inside(canonicalRoot, await realpath(current))) throw new Error(`Linked preference paths are unsupported: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
}
async function snapshot(root: string, file: string, limit = maxFile): Promise<Snapshot> {
  await safePath(root, file);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Preference file is not a regular file under ${limit / 1024} KB: ${file}`);
    return { file, bytes: await readFile(file) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, bytes: null }; throw error; }
}
function text(bytes: Buffer | null, fallback: string): string {
  if (bytes === null) return fallback;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error('Preferences must be valid UTF-8.'); }
}
function json(value: string, label: string, kind: 'object' | 'array'): any {
  const errors: ParseError[] = [];
  const tree = parseTree(value, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !tree || tree.type !== kind) throw new Error(`${label} is malformed. Fix its JSON before importing.`);
  const visit = (node: Node) => {
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const entry of node.children || []) {
        const key = entry.children?.[0]?.value as string;
        if (names.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label} contains a duplicate or reserved key: ${key}`);
        names.add(key);
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  return getNodeValue(tree);
}
function edit(original: string, location: (string | number)[], value: unknown): string {
  return applyEdits(original, modify(original, location, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } }));
}
function sensitive(value: unknown, key = ''): boolean {
  if (/(?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|credential|authorization)/i.test(key) || /(?:^|[._-])(?:token|auth)(?:$|[._-])/i.test(key)) return true;
  return !!value && typeof value === 'object' && Object.entries(value).some(([name, child]) => sensitive(child, name));
}
function validBinding(value: any): boolean {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.key === 'string' && value.key.length > 0 && value.key.length < 512 && typeof value.command === 'string' && value.command.length > 0 && value.command.length < 512 && (value.when === undefined || typeof value.when === 'string') && Object.keys(value).every(key => ['key', 'command', 'when', 'args'].includes(key));
}
function validSnippets(value: Record<string, any>): boolean {
  return Object.values(value).every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && (typeof entry.body === 'string' || Array.isArray(entry.body) && entry.body.every((line: unknown) => typeof line === 'string')) && (entry.prefix === undefined || typeof entry.prefix === 'string' || Array.isArray(entry.prefix) && entry.prefix.every((prefix: unknown) => typeof prefix === 'string')));
}
const snippetName = (name: string) => name.length < 200 && path.basename(name) === name && !name.includes('\\') && !name.includes('/') && /(?:\.json|\.code-snippets)$/i.test(name);

export class ProfileImporter {
  private readonly journalDirectory: string;
  constructor(readonly profile: ProfileResources, storageDirectory: string, private readonly beforeWrite: (files: string[]) => Promise<void> = async () => {}) {
    this.journalDirectory = path.join(storageDirectory, 'preference-imports', createHash('sha256').update(profileIdentity(profile)).digest('hex').slice(0, 24));
  }
  private async validate(): Promise<void> {
    for (const file of [this.profile.settings, this.profile.keybindings, path.join(this.profile.snippets, 'probe.json'), path.join(this.journalDirectory, 'latest.json')]) await safePath(this.profile.root, file);
    if (path.basename(this.profile.settings) !== 'settings.json' || path.basename(this.profile.keybindings) !== 'keybindings.json' || path.basename(this.profile.snippets) !== 'snippets') throw new Error('Unexpected Hydra profile resources.');
  }
  async preview(sourceDirectory: string, options: ImportOptions): Promise<ImportPlan> {
    await this.validate();
    if (!path.isAbsolute(sourceDirectory)) throw new Error('Choose an absolute User or profile settings folder.');
    const source = await realpath(sourceDirectory).catch(() => { throw new Error('Settings folder not found. Choose its User or profile folder instead.'); });
    const destination = await realpath(this.profile.root);
    if (source === destination || inside(source, destination) || inside(destination, source)) throw new Error('Choose VS Code or Cursor preferences outside Hydra’s profile.');
    const inputs: Snapshot[] = [], changes: Change[] = [], items: ImportItem[] = [], warnings: string[] = [];
    let total = 0;
    const read = async (root: string, file: string) => { const value = await snapshot(root, file); inputs.push(value); total += value.bytes?.length || 0; if (total > 10 * 1024 * 1024) throw new Error('Preferences exceed the 10 MB import limit.'); return value; };
    const mergeObject = (category: 'settings' | 'snippets', incoming: Record<string, unknown>, current: Record<string, unknown>, original: string, prefix = '', location: string[] = []): string => {
      if (Object.keys(incoming).length > 2000) throw new Error('A preference file has too many entries to preview.');
      for (const [key, value] of Object.entries(incoming)) {
        const name = prefix + key;
        if (category === 'settings') {
          if (key === 'hydra.handoff') { items.push({ category, name, state: 'skip', detail: 'Task handoff state is not a preference' }); continue; }
          if (sensitive(value, key)) { items.push({ category, name, state: 'skip', detail: 'Account or credential preference' }); continue; }
          if (location.length === 0 && /^(?:\[[^\[\]]+\])+$/.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
            const existing = current[key];
            if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) { items.push({ category, name, state: 'conflict' }); continue; }
            original = mergeObject(category, value as Record<string, unknown>, (existing || {}) as Record<string, unknown>, original, `${key} / `, [key]); continue;
          }
          if (!options.knownSettings.includes(key)) { items.push({ category, name, state: 'skip', detail: 'Setting is unavailable in Hydra' }); continue; }
          if (key === 'workbench.colorTheme' && (typeof value !== 'string' || !options.themes.includes(value))) { items.push({ category, name, state: 'skip', detail: 'Theme is not installed; keep Hydra’s current theme' }); continue; }
        }
        if (Object.hasOwn(current, key)) { items.push({ category, name, state: equal(current[key], value) ? 'skip' : 'conflict', detail: equal(current[key], value) ? 'Already present' : 'Keep the current Hydra preference' }); continue; }
        original = edit(original, [...location, key], value); current[key] = value; items.push({ category, name, state: 'add' });
      }
      return original;
    };
    const settings = await read(source, path.join(source, 'settings.json'));
    const targetSettings = await read(this.profile.root, this.profile.settings);
    if (settings.bytes) {
      const original = text(targetSettings.bytes, '{}\n');
      const after = mergeObject('settings', json(text(settings.bytes, '{}'), 'Source settings', 'object'), json(original, 'Hydra settings', 'object'), original);
      if (after !== original) changes.push({ ...targetSettings, category: 'settings', after: Buffer.from(after) });
    }
    const bindings = await read(source, path.join(source, 'keybindings.json'));
    const targetBindings = await read(this.profile.root, this.profile.keybindings);
    if (bindings.bytes) {
      const incoming = json(text(bindings.bytes, '[]'), 'Source keybindings', 'array') as any[];
      let original = text(targetBindings.bytes, '[]\n');
      const current = json(original, 'Hydra keybindings', 'array') as any[];
      if (![...incoming, ...current].every(validBinding)) throw new Error('Keybindings need a key, command, optional when, and optional args.');
      const keyIdentity = (key: string) => key.trim().toLowerCase().replace(/\s+/g, ' ');
      const protectedBindings = [...current];
      const before = original;
      for (const binding of incoming) {
        const name = `${binding.key}${binding.when ? ` (${binding.when})` : ''}`;
        if (sensitive(binding.args)) { items.push({ category: 'keybindings', name, state: 'skip', detail: 'Credential arguments' }); continue; }
        // Existing user chords win even if incoming conditions differ or overlap.
        const existing = protectedBindings.find(entry => keyIdentity(entry.key) === keyIdentity(binding.key)) || current.find(entry => keyIdentity(entry.key) === keyIdentity(binding.key) && (entry.when || '') === (binding.when || ''));
        if (existing) { items.push({ category: 'keybindings', name, state: equal(existing, binding) ? 'skip' : 'conflict', detail: 'Keep the current Hydra binding' }); continue; }
        original = edit(original, [current.length], binding); current.push(binding); items.push({ category: 'keybindings', name, state: 'add' });
        if (!options.commands.includes(binding.command.replace(/^-/, ''))) warnings.push(`Command is not available yet: ${binding.command}`);
      }
      if (original !== before) changes.push({ ...targetBindings, category: 'keybindings', after: Buffer.from(original) });
    }
    const snippetsDirectory = path.join(source, 'snippets');
    await safePath(source, snippetsDirectory);
    const names = await readdir(snippetsDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    const snippets = names.filter(snippetName).sort();
    if (snippets.length > 100) throw new Error('Choose a profile with no more than 100 snippet files.');
    for (const name of snippets) {
      const incoming = await read(source, path.join(snippetsDirectory, name));
      const target = await read(this.profile.root, path.join(this.profile.snippets, name));
      const original = text(target.bytes, '{}\n');
      const sourceJson = json(text(incoming.bytes, '{}'), `Source snippet ${name}`, 'object');
      const targetJson = json(original, `Hydra snippet ${name}`, 'object');
      if (!validSnippets(sourceJson) || !validSnippets(targetJson)) throw new Error(`Snippet ${name} contains an invalid snippet body or prefix.`);
      const after = mergeObject('snippets', sourceJson, targetJson, original, `${name} / `);
      if (after !== original) changes.push({ ...target, category: 'snippets', after: Buffer.from(after) });
      if (name.endsWith('.json') && !options.languages.includes(name.slice(0, -5))) warnings.push(`Snippet language is not available yet: ${name.slice(0, -5)}`);
    }
    if (!settings.bytes && !bindings.bytes && !snippets.length) throw new Error('No settings, keybindings, or snippets found. Choose the application’s User or profile folder.');
    if (items.length > 5000) throw new Error('There are too many preferences to preview in one import.');
    if (changes.some(change => change.after.length > maxFile)) throw new Error('A merged preference file exceeds the 1 MB file limit. Reduce its entries before importing.');
    return { token: randomUUID(), source, profile: { ...this.profile }, items, warnings: [...new Set(warnings)], inputs, changes };
  }
  private allowedFile(file: string, category: ImportCategory): boolean {
    return category === 'settings' ? file === this.profile.settings : category === 'keybindings' ? file === this.profile.keybindings : category === 'snippets' && path.dirname(file) === this.profile.snippets && snippetName(path.basename(file));
  }
  private async atomic(file: string, bytes: Buffer): Promise<void> {
    await safePath(this.profile.root, file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await safePath(this.profile.root, file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async journal(): Promise<{ file: string; value: Journal } | undefined> {
    const pointer = await snapshot(this.profile.root, path.join(this.journalDirectory, 'latest.json'));
    if (!pointer.bytes) return;
    const id = JSON.parse(pointer.bytes.toString()).id as unknown;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid import backup pointer.');
    const file = path.join(this.journalDirectory, `${id}.json`);
    const data = await snapshot(this.profile.root, file, 64 * 1024 * 1024);
    const value = JSON.parse(data.bytes?.toString() || '') as Journal;
    if (value.version !== 1 || !['prepared', 'applied', 'undone'].includes(value.state) || profileIdentity(value.profile) !== profileIdentity(this.profile) || !Array.isArray(value.files) || value.files.length > 102 || value.files.some(entry => !this.allowedFile(entry.file, entry.category) || (entry.before !== null && (typeof entry.before !== 'string' || entry.before.length > Math.ceil(maxFile / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.before))) || !/^[a-f0-9]{64}$/.test(entry.afterHash)) || new Set(value.files.map(entry => entry.file)).size !== value.files.length) throw new Error('Invalid import backup; no preferences changed.');
    return { file, value };
  }
  async undoStatus(): Promise<{ available: boolean; interrupted: boolean; files: string[] }> {
    await this.validate();
    const journal = await this.journal();
    return { available: !!journal && journal.value.state !== 'undone', interrupted: journal?.value.state === 'prepared', files: journal?.value.files.map(entry => entry.file) || [] };
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.validate();
    const lockDirectory = path.join(path.dirname(this.journalDirectory), 'locks');
    await safePath(this.profile.root, path.join(lockDirectory, 'probe.json'));
    const lock = new OwnershipLock();
    await lock.acquire(lockDirectory, this.profile.root).catch(error => { if (error instanceof Error && error.message.includes('already managed')) throw new Error('Preferences are being changed in another Hydra window. Finish that action before retrying.'); throw error; });
    try { return await operation(); } finally { await lock.release(); }
  }
  async apply(plan: ImportPlan, selected: ImportCategory[]): Promise<number> {
    return this.locked(async () => {
      if (profileIdentity(plan.profile) !== profileIdentity(this.profile) || !Array.isArray(selected) || !selected.length || selected.some(category => !categories.includes(category))) throw new Error('Invalid import selection. Preview again.');
      if ((await this.journal())?.value.state === 'prepared') throw new Error('An earlier import was interrupted. Undo it before importing again.');
      const changes = plan.changes.filter(change => selected.includes(change.category));
      if (!changes.length) throw new Error('No new preferences selected. Existing preferences are preserved.');
      if (changes.some(change => !this.allowedFile(change.file, change.category))) throw new Error('Invalid import destination.');
      await this.beforeWrite(changes.map(change => change.file));
      for (const input of plan.inputs) {
        const root = inside(plan.source, input.file) ? plan.source : this.profile.root;
        if (hash((await snapshot(root, input.file)).bytes) !== hash(input.bytes)) throw new Error('Preferences changed since the preview. Preview again before importing.');
      }
      const value: Journal = { version: 1, profile: this.profile, state: 'prepared', files: changes.map(change => ({ file: change.file, category: change.category, before: change.bytes?.toString('base64') ?? null, afterHash: hash(change.after) })) };
      const id = randomUUID(), file = path.join(this.journalDirectory, `${id}.json`);
      await this.atomic(file, Buffer.from(JSON.stringify(value)));
      await this.atomic(path.join(this.journalDirectory, 'latest.json'), Buffer.from(JSON.stringify({ id })));
      try {
        for (const change of changes) {
          if (!this.allowedFile(change.file, change.category)) throw new Error('Invalid import destination.');
          await this.beforeWrite([change.file]);
          if (hash((await snapshot(this.profile.root, change.file)).bytes) !== hash(change.bytes)) throw new Error('Hydra preferences changed during import.');
          await this.atomic(change.file, change.after);
        }
        value.state = 'applied'; await this.atomic(file, Buffer.from(JSON.stringify(value)));
      } catch (error) {
        try { await this.restore(file, value); } catch { throw new Error('Import was interrupted; newer edits were preserved. Use Undo last import or inspect the retained backup before retrying.'); }
        throw error;
      }
      return changes.length;
    });
  }
  private async restore(file: string, value: Journal): Promise<void> {
    await this.beforeWrite(value.files.map(entry => entry.file));
    for (const entry of value.files) {
      const current = hash((await snapshot(this.profile.root, entry.file)).bytes), before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
      if (current !== entry.afterHash && !(value.state === 'prepared' && current === hash(before))) throw new Error('Hydra preferences changed after import. Undo would overwrite newer edits; your backup is retained.');
    }
    value.state = 'prepared'; await this.atomic(file, Buffer.from(JSON.stringify(value)));
    for (const entry of [...value.files].reverse()) {
      const before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
      const current = hash((await snapshot(this.profile.root, entry.file)).bytes);
      if (value.state === 'prepared' && current === hash(before)) continue;
      if (current !== entry.afterHash) throw new Error('Hydra preferences changed during undo; backup retained.');
      await this.beforeWrite([entry.file]);
      if (before === null) await unlink(entry.file); else await this.atomic(entry.file, before);
    }
    value.state = 'undone'; await this.atomic(file, Buffer.from(JSON.stringify(value)));
  }
  async undo(): Promise<void> { await this.locked(async () => { const journal = await this.journal(); if (!journal || journal.value.state === 'undone') throw new Error('There is no import to undo.'); await this.restore(journal.file, journal.value); }); }
}
