import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationRunBudgetView } from '../webview/DelegationRunBudgetView';
import type { DelegationRunUsageProjection } from '../src/core/delegationRunAccounting';

const missing = { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 };
const measured = { ...missing, recordedTurns: 1, tasksWithoutHistory: 0, codex: { input: 40, output: 10 } };
const run: DelegationRunUsageProjection = { parentId: '1'.repeat(12), runId: '2'.repeat(12), total: measured, coverage: 'partial', stages: {
  planning: { usage: measured, coverage: 'available' }, child: { usage: missing, coverage: 'unavailable' }, retry: { usage: missing, coverage: 'unavailable' }, review: { usage: missing, coverage: 'unavailable' }, validation: { usage: missing, coverage: 'unavailable' }
} };

test('run budget view distinguishes observed usage, unknown child and held reservation without running work', () => {
  const html = renderToStaticMarkup(React.createElement(DelegationRunBudgetView, { run, children: [{ childKey: 'parser', usage: missing, coverage: 'unavailable' }], reservations: [{ version: 1, parentId: run.parentId, runId: run.runId, dispatchKey: 'a'.repeat(24), request: 'startManaged', acquiredAt: '2026-09-19T00:00:00.000Z' }], holds: [{ provider: 'codex', reason: 'Reported soft limit reached' }] }));
  assert.match(html, /50<\/strong>/);
  assert.match(html, /Partial reported coverage/);
  assert.match(html, /parser<\/code><strong>Unavailable/);
  assert.match(html, /Pending reservation/);
  assert.match(html, /Reported soft limit reached/);
  assert.match(html, /not an enforced account spending cap/);
  assert.doesNotMatch(html, /<button|<form/);
});
