import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FocusedWorkspace } from '../webview/FocusedWorkspace';
import { DelegationContextInbox } from '../webview/DelegationContextInbox';
import { DelegationResultInspection } from '../webview/DelegationResultInspection';
import { DelegationRunBudgetView } from '../webview/DelegationRunBudgetView';
import type { Task } from '../src/core/model';
import type { DelegationRunUsageProjection } from '../src/core/delegationRunAccounting';

const root = process.cwd();
const source = async (file: string) => readFile(path.join(root, file), 'utf8');
const fixture = path.join(root, 'tests', 'fixtures', 'native-workflow-acceptance.json');

test('native workflow fixture preserves Editor and Agents ownership without a provider, login, or install', async () => {
  const [extension, smoke, record] = await Promise.all([
    source('src/extension.ts'), source('tests/smoke.ts'), readFile(fixture, 'utf8').then(JSON.parse)
  ]);
  assert.match(extension, /hydra\.toggleMode[\s\S]*?this\.mode === 'editor' \? this\.openAgents\(\) : this\.openEditor\(\)/);
  assert.match(extension, /hydra\.openTask[\s\S]*?this\.selectedId = id; await this\.openAgents\(\)/);
  assert.match(smoke, /three mode cycles preserve unsaved text, selection, focus, and a live terminal process/);
  assert.equal(record.status, 'human-visual-accessibility-acceptance-pending');
  assert.deepEqual(record.scope, { host: 'local VS Code/Hydra fixture only', providerTurn: false, login: false, install: false });
});

test('native workflow fixture covers selected workspace, read-only delegation inspection, budget labels, and accessibility contracts', async () => {
  const [workspace, context, result, budget, map, mapCss, contextCss, resultCss, budgetCss, record] = await Promise.all([
    source('webview/FocusedWorkspace.tsx'), source('webview/DelegationContextInbox.tsx'), source('webview/DelegationResultInspection.tsx'),
    source('webview/DelegationRunBudgetView.tsx'), source('webview/AgentMap.tsx'), source('webview/agent-map.css'),
    source('webview/delegation-context-inbox.css'), source('webview/delegation-result-inspection.css'), source('webview/delegation-run-budget-view.css'),
    readFile(fixture, 'utf8').then(JSON.parse)
  ]);
  assert.match(workspace, /aria-label={`Focused workspace for \${task\.title}`}/);
  assert.match(workspace, /Viewing never starts a terminal, preview, check, model turn, or reconciliation action/);
  assert.match(context, /aria-label={`Context requests for \${binding\.childKey} in run \${binding\.runId}`}/);
  assert.match(result, /Opening this view does not open artifacts, copy logs or transcripts, run checks, start a process, or submit a model request/);
  assert.match(budget, /reported input \+ output tokens/);
  assert.match(map, /tabIndex={0}/);
  assert.match(mapCss, /\.agent-map-task:focus-visible/);
  assert.match(mapCss, /body\.vscode-high-contrast/);
  for (const css of [mapCss, contextCss, resultCss, budgetCss]) assert.match(css, /prefers-reduced-motion: reduce/);
  assert.ok(record.automatedAssertions.every((item: { status: string }) => item.status === 'defined'));
  assert.equal(record.humanAcceptance.status, 'pending');
});

test('focused runtime markup keeps one selected child, pending context, blocked result and unknown budget visible', () => {
  const parentId = '1'.repeat(12), runId = '2'.repeat(12), childId = '3'.repeat(12);
  const task: Task = { id: childId, title: 'Selected parser', prompt: 'fixture', repository: 'C:/repo', worktree: 'C:/repo/parser', branch: 'agent/parser', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', delegation: { parentId, runId, childKey: 'parser', dispatchKey: 'b'.repeat(24), dependencies: [] } };
  const binding = { parentId, runId, childKey: 'parser' };
  const context = renderToStaticMarkup(React.createElement(DelegationContextInbox, { binding, requests: [
    { requestKey: 'c'.repeat(24), binding, requested: [{ id: 'api', path: 'src/api.ts', revision: 'a'.repeat(40), scope: 'src' }], state: 'pending', sourceAvailability: 'unavailable' },
    { requestKey: 'd'.repeat(24), binding: { ...binding, childKey: 'other' }, requested: [], state: 'pending' }
  ] }));
  assert.match(renderToStaticMarkup(React.createElement(FocusedWorkspace, { task, files: [] })), /Focused workspace for Selected parser/);
  assert.match(context, /Context requests for parser in run/);
  assert.match(context, /source unavailable/);
  assert.doesNotMatch(context, new RegExp('d{24}'));
  assert.match(renderToStaticMarkup(React.createElement(DelegationResultInspection, { identity: binding })), /Blocked/);
  const missing = { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 };
  const stages = Object.fromEntries(['planning', 'child', 'retry', 'review', 'validation'].map(stage => [stage, { usage: missing, coverage: 'unavailable' }])) as DelegationRunUsageProjection['stages'];
  const run: DelegationRunUsageProjection = { parentId, runId, total: missing, coverage: 'unavailable', stages };
  const budget = renderToStaticMarkup(React.createElement(DelegationRunBudgetView, { run, children: [], reservations: [], holds: [] }));
  assert.match(budget, /Usage unavailable/);
  assert.doesNotMatch(budget, /<button|<form/);
});

test('editor agent panel has the compact Cursor-style conversation hierarchy without changing native editor ownership', async () => {
  const [editor, css] = await Promise.all([source('webview/EditorConversation.tsx'), source('webview/editor-conversation.css')]);
  assert.match(editor, /className="chat-brand"/);
  assert.match(editor, /className="chat-mark"/);
  assert.match(editor, /className="chat-toolbar-actions"/);
  // The panel mirrors the provider's own chat surface: one quiet identity line,
  // then messages. The stacked conversation/identity/provider header rows are gone.
  assert.match(editor, /className="chat-quiet"/);
  assert.doesNotMatch(editor, /chat-task-picker|chat-identity|chat-details|provider-badge/);
  // Branch and worktree stay: Hydra runs each agent in its own worktree, which the
  // surface it mirrors has no equivalent for, so this is the one thing it must keep.
  assert.match(editor, /className="chat-quiet-branch"/);
  assert.match(editor, /task\.worktree/);
  assert.match(css, /\.chat-toolbar \{ min-height: 42px/);
  assert.match(css, /\.chat-quiet \{[\s\S]*border-bottom: 1px solid var\(--border\)/);
  // The removed chrome must not leave dead rules behind in the stylesheet.
  assert.doesNotMatch(css, /\.chat-task-picker|\.chat-identity|\.chat-details|\.provider-badge|\.chat-worktree|\.editor-conversation \.follow-up/);
  assert.match(css, /body\.vscode-high-contrast/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
