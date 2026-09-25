import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Ctrl+Shift+, opens Hydra Settings', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(manifest.contributes.keybindings.some((binding: { command: string; key: string; mac?: string }) => binding.command === 'hydra.openSettings' && binding.key === 'ctrl+shift+,' && binding.mac === 'cmd+shift+,'));
  assert.ok(manifest.contributes.commands.some((command: { command: string }) => command.command === 'hydra.openSettings'));
});

test('Hydra Settings leads the title bar gear menu', async () => {
  const workbench = await readFile('desktop/workbench/hydraProfile.ts', 'utf8');
  assert.match(workbench, /MenuRegistry\.appendMenuItem\(MenuId\.GlobalActivity, \{ command: \{ id: 'hydra\.openSettings', title: 'Hydra Settings' \}, group: '0_hydra'/);
});
