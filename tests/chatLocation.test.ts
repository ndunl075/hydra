import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeChatLocation, chatLocationPlan, openCommandFor } from '../src/core/chatLocation';

test('normalizeChatLocation defaults anything but "tabs" to docked', () => {
  assert.equal(normalizeChatLocation('tabs'), 'tabs');
  assert.equal(normalizeChatLocation('docked'), 'docked');
  assert.equal(normalizeChatLocation(undefined), 'docked');
  assert.equal(normalizeChatLocation('bogus'), 'docked');
  assert.equal(normalizeChatLocation(null), 'docked');
});

test('docked keeps Claude and Codex in their side bar views', () => {
  const plan = chatLocationPlan('docked');
  assert.equal(plan.claudePreferredLocation, 'sidebar');
  assert.equal(plan.claudeOpen.command, 'claude-vscode.sidebar.open');
  assert.equal(plan.codexOpen.command, 'chatgpt.openSidebar');
});

test('tabs opens Claude in the panel (editor tab) and Codex as a new Codex agent tab', () => {
  const plan = chatLocationPlan('tabs');
  assert.equal(plan.claudePreferredLocation, 'panel');
  assert.equal(plan.claudeOpen.command, 'claude-vscode.editor.open');
  assert.equal(plan.codexOpen.command, 'chatgpt.newCodexPanel');
});

test('openCommandFor selects the right provider out of the mode plan', () => {
  assert.equal(openCommandFor('claude', 'tabs').command, 'claude-vscode.editor.open');
  assert.equal(openCommandFor('codex', 'tabs').command, 'chatgpt.newCodexPanel');
  assert.equal(openCommandFor('claude', 'docked').command, 'claude-vscode.sidebar.open');
  assert.equal(openCommandFor('codex', 'docked').command, 'chatgpt.openSidebar');
});

test('hydra.chatLocation is a contributed preference-only setting, docked by default', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const property = manifest.contributes.configuration.properties['hydra.chatLocation'];
  assert.deepEqual(property.enum, ['docked', 'tabs']);
  assert.equal(property.default, 'docked');
  const commands = manifest.contributes.commands as { command: string }[];
  assert.ok(commands.some(entry => entry.command === 'hydra.setChatLocation'));
});
