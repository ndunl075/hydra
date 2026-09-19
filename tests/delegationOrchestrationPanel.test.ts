import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { DelegationOrchestrationPanel, delegationOrchestrationPanelData } from '../webview/DelegationOrchestrationPanel';
import type { Snapshot, Task } from '../src/core/model';

const parentId = '1'.repeat(12), childId = '2'.repeat(12), runId = '3'.repeat(12);
const parent: Task = { id: parentId, title: 'Parent', prompt: '', repository: 'C:/repo', worktree: 'C:/parent', branch: 'main', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z' };
const child: Task = { ...parent, id: childId, title: 'Parser', branch: 'agent/parser', worktree: 'C:/child', state: 'idle', delegation: { parentId, runId, childKey: 'parser', dispatchKey: '4'.repeat(24), dependencies: [] }, schedule: { state: 'finished', dependencies: [], artifacts: [] } };
const snapshot = (): Snapshot => ({ tasks: [parent, child], selectedId: parentId, mode: 'agents', repositories: ['C:/repo'], providers: [], files: [], busy: false,
  delegationPlans: { [parentId]: [{ runId, id: '5'.repeat(24), rationale: 'Independent parser work has a separate write scope.', mode: 'auto', decision: 'delegate', children: [{ key: 'parser', goal: 'Parse source', provider: 'codex', writeScope: ['src/parser.ts'], dependencies: [], brief: 'saved brief' }, { key: 'tests', goal: 'Test parser', provider: 'codex', writeScope: ['tests/parser.ts'], dependencies: ['parser'], brief: 'saved brief' }] }] },
  delegationOrchestration: { [`${parentId}:${runId}`]: { events: [], contextRequests: [], results: [] } },
  delegationRunAccounting: { [`${parentId}:${runId}`]: { parentId, runId, total: { recordedTurns: 1, unmeasuredTurns: 1, tasksWithoutHistory: 0 }, coverage: 'partial', stages: { planning: { usage: { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 }, coverage: 'unavailable' }, child: { usage: { recordedTurns: 1, unmeasuredTurns: 1, tasksWithoutHistory: 0 }, coverage: 'partial' }, retry: { usage: { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 }, coverage: 'unavailable' }, review: { usage: { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 }, coverage: 'unavailable' }, validation: { usage: { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 }, coverage: 'unavailable' } } } }
});

function elements(node: React.ReactNode): React.ReactElement[] {
  if (!React.isValidElement(node)) return [];
  const element = node as React.ReactElement<{ children?: React.ReactNode }>;
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
}

function isOpenChildButton(element: React.ReactElement): element is React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>> {
  const props = element.props as React.ButtonHTMLAttributes<HTMLButtonElement>;
  return element.type === 'button' && props.children === 'Open child';
}

function mediaBlock(css: string, condition: string): string {
  const start = css.indexOf(`@media (${condition}) {`);
  assert.notEqual(start, -1, `missing @media (${condition})`);
  const bodyStart = css.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < css.length; index++) {
    if (css[index] === '{') depth++;
    if (css[index] === '}' && --depth === 0) return css.slice(bodyStart + 1, index);
  }
  assert.fail(`unterminated @media (${condition})`);
}

test('orchestration panel joins only saved plans, recorded child state, blockers, and partial coverage', () => {
  const runs = delegationOrchestrationPanelData(snapshot(), parent);
  assert.deepEqual(runs.map(run => [run.decision, run.coverage]), [['delegate', 'partial']]);
  assert.deepEqual(runs[0]!.children.map(child => [child.key, child.state, child.blocker]), [['parser', 'Execution complete - review needed', 'Execution finished without a recorded result receipt.'], ['tests', 'Not materialized', 'No durable child task was recorded.']]);
});

test('opening a rendered child invokes exactly one local selection callback', () => {
  const selected: string[] = [];
  const panel = DelegationOrchestrationPanel({ snapshot: snapshot(), parent, onSelect: id => selected.push(id) });
  const openButtons = elements(panel).filter(isOpenChildButton);
  assert.equal(openButtons.length, 1, 'only materialized children can be opened');
  openButtons[0]!.props.onClick!({} as React.MouseEvent<HTMLButtonElement>);
  assert.deepEqual(selected, [childId], 'the button only selects its recorded child once');
});

test('orchestration panel keeps its compact layout and removes moving affordances when motion is reduced', async () => {
  const css = await import('node:fs/promises').then(fs => fs.readFile('webview/agent-map.css', 'utf8'));
  const reducedMotion = mediaBlock(css, 'prefers-reduced-motion: reduce');
  assert.match(reducedMotion, /\.agent-map-flow, \.agent-map-event-flow \{ animation: none; \}/);
  assert.match(reducedMotion, /\.agent-map-motion \{ display: none; \}/);
  const narrow = mediaBlock(css, 'max-width: 660px');
  assert.match(narrow, /\.delegation-orchestration > header \{ display: grid; gap: 6px; \}/);
  assert.match(narrow, /\.delegation-orchestration-run li \{ align-items: start; flex-direction: column; \}/);
  assert.match(narrow, /\.delegation-orchestration-run li button \{ align-self: stretch; \}/);
});
