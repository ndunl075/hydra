import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FocusedWorkspace } from '../webview/FocusedWorkspace';
import { SessionThread } from '../webview/SessionThread';
import type { Task } from '../src/core/model';

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

test('native workflow fixture covers the selected workspace, the agent map, and accessibility contracts', async () => {
  const [workspace, map, mapCss, record] = await Promise.all([
    source('webview/FocusedWorkspace.tsx'), source('webview/AgentsCanvas.tsx'), source('webview/agents-canvas.css'),
    readFile(fixture, 'utf8').then(JSON.parse)
  ]);
  assert.match(workspace, /aria-label={`Focused workspace for \${task\.title}`}/);
  assert.match(workspace, /Viewing never starts a terminal, preview, check, model turn, or reconciliation action/);
  assert.match(map, /tabIndex={0}/);
  assert.match(mapCss, /\.canvas-node:focus-visible/);
  assert.match(mapCss, /body\.vscode-high-contrast/);
  assert.match(mapCss, /prefers-reduced-motion: reduce/);
  assert.ok(record.automatedAssertions.every((item: { status: string }) => item.status === 'defined'));
  assert.equal(record.humanAcceptance.status, 'pending');
});

test('editor agent panel has the compact Cursor-style conversation hierarchy without changing native editor ownership', async () => {
  const [editor, css, pickers, thread] = await Promise.all([source('webview/EditorConversation.tsx'), source('webview/editor-conversation.css'), source('webview/ComposerPickers.tsx'), source('webview/SessionThread.tsx')]);
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
  // The conversation switcher is a themed menu, not a native <select>: Chromium
  // hands an open select to the OS, which draws a popup CSS cannot style.
  assert.doesNotMatch(editor, /<select aria-label="Conversation"/);
  assert.match(editor, /function ConversationMenu/);
  // With no model chosen the model chip names the provider. "Provider defaults"
  // sat beside Claude's permission mode, which is literally named "default".
  assert.match(pickers, /: providerLabel\[provider\];/);
  // Effort is chosen, not implied: Claude's catalog has no default effort, and
  // taking the first level silently set Claude models to the lowest one.
  assert.match(pickers, /aria-label="Effort"/);
  assert.match(pickers, /model\.efforts\.includes\('medium'\)/);
  assert.doesNotMatch(pickers, /model\.efforts\[0\] \|\| ''/);
  // Inside a conversation the composer uses the same pickers until launch, then
  // reports them read-only; provider can change only before the first launch.
  assert.match(thread, /const editable = canEditBrief\(task, session\)/);
  assert.match(thread, /type: 'saveProviderSelection'/);
  assert.match(thread, /<ContextRing usage=\{latestContextUsage\(session\.turns\)\} \/>/);
  // The composer has no drag handle; it sizes itself between min and max height.
  assert.match(css, /\.task-prompt-box \.task-prompt-textarea \{[^}]*resize: none;/);
  // Claude-style input: one line tall, grows with its content up to 200px.
  assert.match(css, /\.task-prompt-box \.task-prompt-textarea \{[^}]*field-sizing: content;[^}]*max-height: 200px;/);
  assert.match(css, /body\.vscode-high-contrast/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('an unstarted task still accepts typing: the box extends the first message and send starts the task', () => {
  const task: Task = { id: '4'.repeat(12), title: 'hi', prompt: 'hi', repository: 'C:/repo', worktree: 'C:/repo/wt', branch: 'agent/hi', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'claude', interface: 'interactive-cli', state: 'idle', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z' };
  const html = renderToStaticMarkup(React.createElement(SessionThread, { task, session: { version: 1, turns: [] }, busy: false, send: () => {}, compact: true, composer: { catalogs: {}, providers: [] } }));
  const textarea = html.match(/<textarea[^>]*>/)![0];
  // It used to be disabled until a session existed, so a never-started task was a dead box.
  assert.doesNotMatch(textarea, /disabled/);
  assert.match(textarea, /placeholder="Add to your first message, or send to start"/);
  assert.match(html, /aria-label="Start task"/);
});
