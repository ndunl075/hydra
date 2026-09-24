import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preferenceOnlySettings, settingsRequiringRefresh } from '../src/core/settingsRefresh';

test('only preferences read fresh (the head cap) skip the provider reset; every other Hydra setting refreshes', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const contributed = [manifest.contributes.configuration].flat().flatMap((section: { properties?: Record<string, unknown> }) => Object.keys(section.properties || {}));
  const refreshing = settingsRequiringRefresh(contributed);
  // Solo/Auto used to clear both model catalogs and run a full refresh on every flip.
  for (const key of preferenceOnlySettings) { assert.ok(contributed.includes(key), `${key} is a real setting`); assert.ok(!refreshing.includes(key)); }
  // Anything that changes which CLI runs, where worktrees go, or capacity still refreshes.
  for (const key of ['hydra.claudePath', 'hydra.codexPath', 'hydra.defaultProvider', 'hydra.worktreeRoot', 'hydra.maxConcurrentTasks']) assert.ok(refreshing.includes(key), key);
  assert.equal(refreshing.length, contributed.length - preferenceOnlySettings.size);
  // No readable manifest: fail safe to a full refresh.
  assert.deepEqual(settingsRequiringRefresh([]), ['hydra']);
});
