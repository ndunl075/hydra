import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterPages, matchesQuery, matchingRows } from '../src/settings/search';
import { pageOrder } from '../src/settings/pageOrder';
import { dismissedPromptKeys, clearDismissedPrompts } from '../src/settings/dismissedPrompts';

test('nav order is General, Connectors, MCP servers, Heads, Appearance, Docs', () => {
  assert.deepEqual(pageOrder, ['general', 'connectors', 'mcpServers', 'heads', 'appearance', 'docs']);
});

test('the page registry (src/settings/pages/index.ts) follows pageOrder', async () => {
  const source = await readFile('src/settings/pages/index.ts', 'utf8');
  const byId = source.match(/const byId: Record<string, SettingsPage> = \{([\s\S]*?)\};/)?.[1] || '';
  const declared = [...byId.matchAll(/^\s*(\w+):/gm)].map(match => match[1]);
  assert.deepEqual(declared, [...pageOrder]);
});

test('matchesQuery is a case-insensitive substring match', () => {
  assert.ok(matchesQuery('Heads at a time', 'heads'));
  assert.ok(matchesQuery('Heads at a time', 'AT A'));
  assert.ok(!matchesQuery('Heads at a time', 'tabs'));
});

test('filterPages: empty query keeps every page in order; a query keeps only pages with a matching title or row', () => {
  const pages = [
    { id: 'a', title: 'General', rows: [{ title: 'Chat location', description: 'Docked or tabs' }] },
    { id: 'b', title: 'Appearance', rows: [{ title: 'Dark / Light', description: 'Editor theme' }] },
    { id: 'c', title: 'Docs', rows: [{ title: 'README', description: 'What Hydra is' }] },
  ];
  assert.deepEqual(filterPages(pages, ''), ['a', 'b', 'c']);
  assert.deepEqual(filterPages(pages, 'tabs'), ['a']);
  assert.deepEqual(filterPages(pages, 'theme'), ['b']);
  assert.deepEqual(filterPages(pages, 'appearance'), ['b']);
  assert.deepEqual(filterPages(pages, 'nonexistent'), []);
});

test('matchingRows filters one page\'s rows by title or description', () => {
  const page = { id: 'a', title: 'General', rows: [{ title: 'Chat location', description: 'Docked or tabs' }, { title: 'Editor settings', description: 'Font, formatting' }] };
  assert.deepEqual(matchingRows(page, ''), page.rows);
  assert.deepEqual(matchingRows(page, 'font'), [page.rows[1]]);
  assert.deepEqual(matchingRows(page, 'docked'), [page.rows[0]]);
});

test('dismissed prompts: the only one-time flag found is the first-run sidebar collapse; clearing removes it', async () => {
  assert.deepEqual(dismissedPromptKeys, ['hydra.firstRunLayout.v1']);
  const updated: [string, unknown][] = [];
  const fakeState = { update: (key: string, value: unknown) => { updated.push([key, value]); return Promise.resolve(); } };
  await clearDismissedPrompts(fakeState);
  assert.deepEqual(updated, [['hydra.firstRunLayout.v1', undefined]]);
});

test('extension.ts wires hydra.openSettings to AppearanceSettings.show(pageId)', async () => {
  const source = await readFile('src/extension.ts', 'utf8');
  assert.match(source, /command\('hydra\.openSettings', \(pageId\?: string\) => this\.settings\.show\(pageId\)\)/);
  assert.match(source, /new AppearanceSettings\(context, this\.settingsImport\)/);
});
