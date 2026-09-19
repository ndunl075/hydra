import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSelectedTaskSetupPreview } from '../src/core/setupPreviewProjection';
import { selectedRunPanelData } from '../webview/delegationRunPanelData';
import type { Snapshot, Task } from '../src/core/model';
import type { ResourceView } from '../src/core/resourceModel';

const parentId = '1'.repeat(12), runId = '2'.repeat(12);
const task = (id: string, childKey: string): Task => ({ id, title: childKey, prompt: 'fixture', repository: process.cwd(), worktree: process.cwd(), branch: childKey, baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', delegation: { parentId, runId, childKey, dispatchKey: id.repeat(2), dependencies: [] } });
const resource = (reserved: boolean, status: ResourceView['status']): ResourceView => ({ config: { port: 4600, database: 'hydra_db', commands: [{ executable: 'node', args: ['secret-argument'] }], timeoutMs: 30000 }, reserved, status, checks: [], updatedAt: '2026-09-19T00:00:00.000Z' });

test('saved setup projects a stable digest and distinguishes reservations from backing service state', () => {
  const child = task('3'.repeat(12), 'parser');
  const saved = projectSelectedTaskSetupPreview(child, { [child.id]: resource(true, 'unchecked') });
  assert.match(saved.recipe!.digest, /^[a-f0-9]{64}$/);
  assert.equal(saved.recipe!.timeoutMs, 30000);
  assert.deepEqual(saved.recipe!.commands.map(command => command.argumentCount), [1]);
  assert.equal(JSON.stringify(saved).includes('secret-argument'), false);
  assert.deepEqual(saved.resources.map(item => item.reservation), ['reserved', 'reserved']);
  assert.equal(saved.resources[1]!.backingService, 'unknown');
  const conflict = projectSelectedTaskSetupPreview(child, { [child.id]: resource(false, 'failed'), ['4'.repeat(12)]: resource(true, 'passed') });
  assert.deepEqual(conflict.resources.map(item => item.reservation), ['conflict', 'conflict']);
  assert.equal(conflict.resources[1]!.backingService, 'missing');
  assert.equal(projectSelectedTaskSetupPreview(child, {}).recipe, undefined);
});

test('run details show exact children, unknown coverage, held budgets and no other run', () => {
  const child = task('3'.repeat(12), 'parser'), sibling = task('4'.repeat(12), 'tests'), other = task('5'.repeat(12), 'other');
  other.delegation!.runId = '9'.repeat(12);
  const snapshot = { tasks: [child, sibling, other], usage: { tasks: { [child.id]: { codex: { input: 20, output: 10 }, recordedTurns: 1, unmeasuredTurns: 0, tasksWithoutHistory: 0 }, [sibling.id]: { recordedTurns: 0, unmeasuredTurns: 0, tasksWithoutHistory: 1 } }, projects: {} }, budgets: { settings: { tasks: {}, projects: {} }, observations: { [child.id]: [{ scope: 'task', provider: 'codex', action: 'hold', metric: 'inputOutputTokens', limit: 20, observed: 30, partial: false, reached: true }] } } } as Snapshot;
  const projected = selectedRunPanelData(snapshot, child);
  assert.deepEqual(projected.children.map(item => [item.childKey, item.coverage]), [['parser', 'available'], ['tests', 'unavailable']]);
  assert.equal(projected.holds.length, 1);
  assert.match(projected.holds[0]!.reason, /budget reached/);
  assert.equal(projected.children.some(item => item.childKey === 'other'), false);
});
