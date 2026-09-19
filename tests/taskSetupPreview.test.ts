import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskSetupPreview } from '../webview/TaskSetupPreview';

const recipe = {
  digest: 'a'.repeat(64), taskId: '123456789abc', workspacePath: 'C:\\worktrees\\task', timeoutMs: 120000,
  reservations: [{ kind: 'port' as const, name: '4312', key: 'port:4312', environment: 'HYDRA_TASK_PORT' }, { kind: 'database' as const, name: 'task_db', key: 'database:task_db', environment: 'HYDRA_TASK_DATABASE' }, { kind: 'service' as const, name: 'task_service', key: 'service:task_service', environment: 'HYDRA_TASK_SERVICE' }],
  environment: [{ name: 'NODE_ENV' }], commands: [{ order: 1, executable: 'node', argumentCount: 2, timeoutMs: 120000 }]
};

test('setup preview is passive and distinguishes a conflict from a missing backing service', () => {
  const html = renderToStaticMarkup(React.createElement(TaskSetupPreview, { recipe, resources: [{ key: 'port:4312', reservation: 'conflict' }, { key: 'database:task_db', reservation: 'reserved', backingService: 'missing' }, { key: 'service:task_service', reservation: 'reserved', backingService: 'available' }] }));
  assert.match(html, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(html, /120s per command/);
  assert.match(html, /Reservation conflict/);
  assert.match(html, /Backing service missing/);
  assert.match(html, /Backing service indicated by setup/);
  assert.match(html, /Reservations are logical Hydra claims/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /<form/);
});

test('setup preview hides raw command arguments and does not infer provisioned backing services', () => {
  const html = renderToStaticMarkup(React.createElement(TaskSetupPreview, { recipe: { ...recipe, commands: [{ ...recipe.commands[0]!, argumentCount: 3 }] } }));
  assert.match(html, /3 arguments hidden/);
  assert.match(html, /Backing service missing/);
  assert.match(html, /Environment values and command arguments are intentionally not displayed/);
  assert.doesNotMatch(html, /password|private-value|--secret/i);
});

test('missing recipes are explicit and passive', () => {
  const html = renderToStaticMarkup(React.createElement(TaskSetupPreview));
  assert.match(html, /Validated recipe unavailable/);
  assert.match(html, /Viewing never runs setup or changes any resource reservation/);
  assert.doesNotMatch(html, /<button/);
});
