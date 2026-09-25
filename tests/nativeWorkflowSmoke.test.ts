import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = async (file: string) => readFile(path.join(root, file), 'utf8');
const fixture = path.join(root, 'tests', 'fixtures', 'native-workflow-acceptance.json');

test('native workflow fixture preserves Editor and Agents ownership without a provider, login, or install', async () => {
  const [extension, smoke, record] = await Promise.all([
    source('src/extension.ts'), source('tests/smoke.ts'), readFile(fixture, 'utf8').then(JSON.parse)
  ]);
  assert.match(extension, /hydra\.toggleMode[\s\S]*?this\.mode === 'editor' \? this\.openAgents\(\) : this\.openEditor\(\)/);
  assert.match(extension, /hydra\.openAgents', \(\) => this\.openAgents\(\)/);
  assert.match(smoke, /three mode cycles preserve unsaved text, selection, focus, and a live terminal process/);
  assert.equal(record.status, 'human-visual-accessibility-acceptance-pending');
  assert.deepEqual(record.scope, { host: 'local VS Code/Hydra fixture only', providerTurn: false, login: false, install: false });
});

test('native workflow fixture covers the agents canvas and accessibility contracts', async () => {
  const [map, mapCss, record] = await Promise.all([
    source('webview/AgentsCanvas.tsx'), source('webview/agents-canvas.css'),
    readFile(fixture, 'utf8').then(JSON.parse)
  ]);
  assert.match(map, /tabIndex={0}/);
  assert.match(mapCss, /\.canvas-node:focus-visible/);
  assert.match(mapCss, /body\.vscode-high-contrast/);
  assert.match(mapCss, /prefers-reduced-motion: reduce/);
  assert.ok(record.automatedAssertions.every((item: { status: string }) => item.status === 'defined'));
  // Every evidence path the record names still exists.
  for (const item of record.automatedAssertions as { evidence: string }[]) for (const file of item.evidence.split(', ')) await source(file);
  assert.equal(record.humanAcceptance.status, 'pending');
});
