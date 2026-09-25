import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHydraTree } from '../src/core/hydraTree';
import type { HelperJobView, LaneView } from '../src/core/model';
import { createPlan, type Plan } from '../src/core/plans';

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const lane = (id: string, name: string, extra: Partial<LaneView> = {}): LaneView => ({
  id, name, provider: 'claude', repository: '/repo', worktree: `/repo.worktrees/${id}`, branch: `lane/${id}`, baseCommit: 'a'.repeat(40),
  target: 'main', createdAt: at(60_000), state: 'running', running: true, ...extra,
});
const head = (id: string, state: string, extra: Partial<HelperJobView> = {}): HelperJobView => ({
  id, title: `Head ${id}`, state, provider: 'claude', createdAt: at(60_000), changedFiles: 0, checks: [], dependsOn: [], ...extra,
});
const plan = (state: Plan['state'], extra: Partial<Plan> = {}): Plan => ({ ...createPlan({ title: 'Checkout refactor', brief: 'Refactor checkout.' }), state, ...extra });

test('the Hydra panel groups open lanes, running heads and live plans; merged/closed lanes and done plans are hidden', () => {
  const tree = buildHydraTree(
    [lane('111111111111', 'Lane 1', { branch: 'lane/x' }), lane('222222222222', 'Lane 2', { state: 'merged' }), lane('333333333333', 'Lane 3', { state: 'closed' })],
    [head('h1', 'running'), head('h2', 'done', { finishedAt: at(0) })],
    [plan('draft'), plan('done')],
  );
  assert.deepEqual(tree.lanes.map(item => item.id), ['111111111111']);
  assert.equal(tree.lanes[0]!.description, 'Claude · lane/x');
  assert.deepEqual(tree.heads.map(item => item.id), ['h1']);
  assert.deepEqual(tree.plans.map(item => item.state), ['draft']);
  assert.equal(tree.empty, false);
});

test('a lane\'s description names its conflicts, and its tree item carries state and dirtiness for the icon and inline actions', () => {
  const conflicted = lane('111111111111', 'Lane 1', { provider: 'codex', sync: { changedFiles: ['a.ts'], conflicts: [{ laneId: '222222222222', files: ['a.ts'] }], targetConflicts: [], behind: 2, dirty: true, checkedAt: at(0) } });
  const tree = buildHydraTree([conflicted], [], []);
  const item = tree.lanes[0]!;
  assert.equal(item.description, 'Codex · lane/111111111111 · conflicts');
  assert.equal(item.conflicts, true);
  assert.equal(item.dirty, true);
});

test('the tree is empty (for the welcome view) only when there are no lanes, heads or plans', () => {
  assert.equal(buildHydraTree([], [], []).empty, true);
  assert.equal(buildHydraTree([lane('111111111111', 'Lane 1')], [], []).empty, false);
});
