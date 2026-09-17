import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'jsonc-parser/lib/esm/main';
import { ProfileImporter, detectedImportFolder, type ImportOptions, type ProfileResources } from '../src/core/profileImport';

const parent = path.resolve('.test-build', 'import-fixtures');
const options: ImportOptions = { knownSettings: ['editor.fontSize', 'editor.tabSize', 'editor.minimap.enabled', 'workbench.colorTheme', 'sample.apiKey', 'hydra.handoff'], themes: ['Hydra Dark', 'Hydra Light'], commands: ['known.command'], languages: ['typescript'] };
async function fixture() {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'spaces ü-'));
  const source = path.join(root, 'Cursor User'), user = path.join(root, 'Hydra User');
  await mkdir(path.join(source, 'snippets'), { recursive: true });
  await mkdir(path.join(user, 'snippets'), { recursive: true });
  const storage = path.join(user, 'globalStorage', 'hydra');
  const profile: ProfileResources = { id: 'default', name: 'Default', root: user, settings: path.join(user, 'settings.json'), keybindings: path.join(user, 'keybindings.json'), snippets: path.join(user, 'snippets') };
  const importer = new ProfileImporter(profile, storage);
  return { root, source, user, storage, profile, importer };
}
async function cleanup(root: string) { assert.ok(root.startsWith(parent + path.sep)); await rm(root, { recursive: true, force: true }); }
async function removeDirectory(file: string) { assert.ok(path.resolve(file).startsWith(parent + path.sep)); await rm(file, { recursive: true, force: true }); }
const exists = async (file: string) => readFile(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('import merges JSONC preferences, keeps conflicts, skips accounts/unavailable themes, and restores exact bytes after restart', async () => {
  const f = await fixture();
  try {
    const beforeSettings = '// Keep this comment\r\n{ "editor.fontSize": 16, "[typescript]": { "editor.fontSize": 17 } }\r\n';
    const beforeBindings = '// My binding\n[{"key":"ctrl+k","command":"my.command"}]\n';
    const beforeSnippets = '// My snippet\n{"Hello":{"prefix":"hi","body":"original"}}\n';
    await writeFile(f.profile.settings, beforeSettings); await writeFile(f.profile.keybindings, beforeBindings);
    await writeFile(path.join(f.profile.snippets, 'typescript.json'), beforeSnippets);
    const sourceSettings = '// From Cursor\n{"editor.fontSize":20,"editor.tabSize":4,"workbench.colorTheme":"Missing Theme","sample.apiKey":"do-not-copy","cursor.privateSetting":true,"hydra.handoff":{"version":1},"[typescript]":{"editor.fontSize":21,"editor.tabSize":2,"hydra.handoff":{"version":1}},}';
    await writeFile(path.join(f.source, 'settings.json'), sourceSettings);
    await writeFile(path.join(f.source, 'keybindings.json'), '[{"key":"CTRL+K","command":"other.command","when":"editorTextFocus"},{"key":"ctrl+l","command":"known.command"},{"key":"ctrl+p","command":"extension.command","args":{"apiKey":"no"}}]');
    await writeFile(path.join(f.source, 'snippets', 'typescript.json'), '{"Hello":{"prefix":"hi","body":"incoming"},"New":{"prefix":"new","body":["line 1","$0"]}}');
    await writeFile(path.join(f.source, 'state.vscdb'), 'credential store'); await writeFile(path.join(f.source, 'auth.json'), 'tokens');
    const plan = await f.importer.preview(f.source, options);
    assert.ok(plan.items.some(item => item.state === 'conflict' && item.name === 'editor.fontSize'));
    assert.ok(plan.items.some(item => item.name === 'workbench.colorTheme' && item.detail?.includes('Theme')));
    assert.ok(plan.items.some(item => item.name === 'sample.apiKey' && item.state === 'skip'));
    assert.equal(plan.items.filter(item => item.name.endsWith('hydra.handoff') && item.state === 'skip' && item.detail?.includes('Task handoff')).length, 2);
    assert.equal(await f.importer.apply(plan, ['settings', 'keybindings', 'snippets']), 3);
    const settings = parse(await readFile(f.profile.settings, 'utf8'));
    assert.deepEqual(settings, { 'editor.fontSize': 16, 'editor.tabSize': 4, '[typescript]': { 'editor.fontSize': 17, 'editor.tabSize': 2 } });
    assert.ok((await readFile(f.profile.settings, 'utf8')).startsWith('// Keep this comment\r\n'));
    assert.deepEqual(parse(await readFile(f.profile.keybindings, 'utf8')), [{ key: 'ctrl+k', command: 'my.command' }, { key: 'ctrl+l', command: 'known.command' }]);
    assert.equal(parse(await readFile(path.join(f.profile.snippets, 'typescript.json'), 'utf8')).Hello.body, 'original');
    assert.equal(await readFile(path.join(f.source, 'settings.json'), 'utf8'), sourceSettings);
    assert.equal(await exists(path.join(f.user, 'state.vscdb')), false); assert.equal(await exists(path.join(f.user, 'auth.json')), false);
    const restarted = new ProfileImporter(f.profile, f.storage);
    assert.equal((await restarted.undoStatus()).available, true); await restarted.undo();
    assert.equal(await readFile(f.profile.settings, 'utf8'), beforeSettings);
    assert.equal(await readFile(f.profile.keybindings, 'utf8'), beforeBindings);
    assert.equal(await readFile(path.join(f.profile.snippets, 'typescript.json'), 'utf8'), beforeSnippets);
    assert.equal((await restarted.undoStatus()).available, false);
  } finally { await cleanup(f.root); }
});

test('selected categories and named profile paths stay isolated; undo removes only newly imported files', async () => {
  const f = await fixture();
  try {
    const location = path.join(f.user, 'profiles', 'custom'); await mkdir(location, { recursive: true });
    const profile = { ...f.profile, id: 'custom', name: 'Custom', settings: path.join(location, 'settings.json'), keybindings: path.join(location, 'keybindings.json'), snippets: path.join(location, 'snippets') };
    await writeFile(f.profile.settings, '{"editor.fontSize":15}');
    await writeFile(path.join(f.source, 'settings.json'), '{"editor.fontSize":22,"workbench.colorTheme":"Hydra Light"}');
    await writeFile(path.join(f.source, 'keybindings.json'), '[{"key":"ctrl+j","command":"missing.command"}]');
    await writeFile(path.join(f.source, 'snippets', 'typescript.json'), '{"New":{"body":"snippet"}}');
    const importer = new ProfileImporter(profile, f.storage); const plan = await importer.preview(f.source, options);
    assert.ok(plan.warnings.some(warning => warning.includes('missing.command')));
    await importer.apply(plan, ['settings']);
    assert.equal(parse(await readFile(profile.settings, 'utf8'))['workbench.colorTheme'], 'Hydra Light');
    assert.equal(await exists(profile.keybindings), false); assert.equal(await exists(path.join(profile.snippets, 'typescript.json')), false);
    assert.equal(await readFile(f.profile.settings, 'utf8'), '{"editor.fontSize":15}');
    await writeFile(path.join(location, 'unrelated.txt'), 'keep'); await importer.undo();
    assert.equal(await exists(profile.settings), false); assert.equal(await readFile(path.join(location, 'unrelated.txt'), 'utf8'), 'keep');
  } finally { await cleanup(f.root); }
});

test('stale source or destination and dirty preferences refuse before changing any files', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.source, 'settings.json'); await writeFile(source, '{"editor.tabSize":4}');
    let plan = await f.importer.preview(f.source, options); await writeFile(source, '{"editor.tabSize":2}');
    await assert.rejects(f.importer.apply(plan, ['settings']), /changed since the preview/); assert.equal(await exists(f.profile.settings), false);
    plan = await f.importer.preview(f.source, options); await writeFile(f.profile.keybindings, '[]');
    await assert.rejects(f.importer.apply(plan, ['settings']), /changed since the preview/); assert.equal(await exists(f.profile.settings), false);
    const dirty = new ProfileImporter(f.profile, f.storage, async () => { throw new Error('unsaved preference buffer'); });
    plan = await dirty.preview(f.source, options); await assert.rejects(dirty.apply(plan, ['settings']), /unsaved/);
    assert.equal((await dirty.undoStatus()).available, false); assert.equal(await exists(f.profile.settings), false);
  } finally { await cleanup(f.root); }
});

test('malformed, duplicate, reserved, oversized, and non-UTF8 preferences fail without partial imports', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.source, 'settings.json');
    for (const bytes of ['{"editor.tabSize":}', '{"editor.tabSize":2,"editor.tabSize":4}', '{"__proto__":{"polluted":true}}', Buffer.from([0xff]), ' '.repeat(1024 * 1024 + 1)]) {
      await writeFile(file, bytes); await assert.rejects(f.importer.preview(f.source, options)); assert.equal(await exists(f.profile.settings), false);
    }
    await writeFile(file, '{"editor.tabSize":4}'); await writeFile(path.join(f.source, 'keybindings.json'), '[{"command":"missing.key"}]');
    await assert.rejects(f.importer.preview(f.source, options), /Keybindings need/);
    await writeFile(path.join(f.source, 'keybindings.json'), '[]'); await writeFile(path.join(f.source, 'snippets', 'typescript.json'), '{"Invalid":{"body":42}}');
    await assert.rejects(f.importer.preview(f.source, options), /invalid snippet/); assert.equal(await exists(f.profile.settings), false);
    assert.equal(({} as any).polluted, undefined);
  } finally { await cleanup(f.root); }
});

test('source/destination junctions and overlapping profiles cannot copy or replace files outside preferences', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'settings.json'), '{"editor.tabSize":4}');
    await assert.rejects(f.importer.preview(f.user, options), /outside Hydra/);
    const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'typescript.json'), '{"Outside":{"body":"private"}}');
    await removeDirectory(path.join(f.source, 'snippets')); await symlink(outside, path.join(f.source, 'snippets'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.importer.preview(f.source, options), /Linked preference/);
    await removeDirectory(path.join(f.source, 'snippets')); await mkdir(path.join(f.source, 'snippets'));
    await removeDirectory(f.profile.snippets); await symlink(outside, f.profile.snippets, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.importer.preview(f.source, options), /Linked preference/);
    assert.equal(await readFile(path.join(outside, 'typescript.json'), 'utf8'), '{"Outside":{"body":"private"}}');
  } finally { await cleanup(f.root); }
});

test('undo refuses newer edits across all files and retains the original backup', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'settings.json'), '{"editor.tabSize":4}'); await writeFile(path.join(f.source, 'keybindings.json'), '[{"key":"ctrl+j","command":"known.command"}]');
    await f.importer.apply(await f.importer.preview(f.source, options), ['settings', 'keybindings']);
    const settingsAfter = await readFile(f.profile.settings); await writeFile(f.profile.keybindings, '[{"key":"ctrl+p","command":"my.new.command"}]');
    await assert.rejects(f.importer.undo(), /overwrite newer edits/); assert.deepEqual(await readFile(f.profile.settings), settingsAfter);
    assert.equal(parse(await readFile(f.profile.keybindings, 'utf8'))[0].command, 'my.new.command'); assert.equal((await f.importer.undoStatus()).available, true);
  } finally { await cleanup(f.root); }
});

test('failed apply rolls back earlier writes; interrupted undo resumes from its persistent journal', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'settings.json'), '{"editor.tabSize":4}'); await writeFile(path.join(f.source, 'keybindings.json'), '[{"key":"ctrl+j","command":"known.command"}]');
    let calls = 0;
    const failing = new ProfileImporter(f.profile, f.storage, async () => { if (++calls === 3) throw new Error('simulated second-file failure'); });
    await assert.rejects(failing.apply(await failing.preview(f.source, options), ['settings', 'keybindings']), /second-file failure/);
    assert.equal(await exists(f.profile.settings), false); assert.equal(await exists(f.profile.keybindings), false); assert.equal((await failing.undoStatus()).available, false);
    await f.importer.apply(await f.importer.preview(f.source, options), ['settings', 'keybindings']);
    calls = 0; const interrupted = new ProfileImporter(f.profile, f.storage, async () => { if (++calls === 3) throw new Error('simulated exit during undo'); });
    await assert.rejects(interrupted.undo(), /exit during undo/); assert.equal((await f.importer.undoStatus()).interrupted, true);
    await new ProfileImporter(f.profile, f.storage).undo(); assert.equal(await exists(f.profile.settings), false); assert.equal(await exists(f.profile.keybindings), false);
  } finally { await cleanup(f.root); }
});

test('cross-window import locking serializes writes and backup metadata cannot redirect undo', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.source, 'settings.json'), '{"editor.tabSize":4}');
    let signal!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const first = new ProfileImporter(f.profile, f.storage, async () => { signal(); await held; });
    const plan = await first.preview(f.source, options); const applying = first.apply(plan, ['settings']); await started;
    try { await assert.rejects(f.importer.apply(plan, ['settings']), /another.*window/); } finally { release(); } await applying;
    const imports = path.join(f.storage, 'preference-imports'), id = (await readdir(imports)).find(name => name !== 'locks')!;
    const journalDirectory = path.join(imports, id), pointer = JSON.parse(await readFile(path.join(journalDirectory, 'latest.json'), 'utf8'));
    const journalFile = path.join(journalDirectory, `${pointer.id}.json`), journal = JSON.parse(await readFile(journalFile, 'utf8'));
    journal.files[0].file = path.join(f.root, 'outside.txt'); await writeFile(journalFile, JSON.stringify(journal));
    await assert.rejects(f.importer.undo(), /Invalid import backup/); assert.equal(await exists(path.join(f.root, 'outside.txt')), false);
    assert.equal(detectedImportFolder('cursor', f.root), path.join(f.root, 'Cursor', 'User'));
  } finally { await cleanup(f.root); }
});
