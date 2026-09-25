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

// ---- Plan lanes (docs/Plan_Lanes_Plan.md, section 5): job progress and a plan lane's description. ----

const planJob = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });

test('a running plan\'s description shows its job progress, including lanes waiting for you', () => {
  const running = plan('running', { jobs: [planJob('a'), planJob('b'), planJob('c')] });
  const views = { [running.id]: [
    { key: 'a', runAs: 'head' as const, status: 'done' as const },
    { key: 'b', runAs: 'lane' as const, status: 'active' as const, laneId: '222222222222' },
    { key: 'c', runAs: 'head' as const, status: 'waiting' as const },
  ] };
  const tree = buildHydraTree([], [], [running], views);
  assert.equal(tree.plans[0]!.description, 'Running · 1 of 3 done · 1 lane waiting');
});

test('an incomplete plan\'s description names what didn\'t finish', () => {
  const incomplete = plan('incomplete', { jobs: [planJob('a'), planJob('b')] });
  const views = { [incomplete.id]: [
    { key: 'a', runAs: 'head' as const, status: 'done' as const },
    { key: 'b', runAs: 'head' as const, status: 'failed' as const, reason: 'oops' },
  ] };
  const tree = buildHydraTree([], [], [incomplete], views);
  assert.equal(tree.plans[0]!.description, 'Incomplete · 1 failed');
});

test('a plan lane\'s description names the plan it belongs to', () => {
  const inPlan = lane('111111111111', 'Build API', { planJob: { planId: 'p1', planTitle: 'Checkout', jobKey: 'build', jobTitle: 'Build API', state: 'active', dependents: 0, dependentsStarted: 0 } });
  const tree = buildHydraTree([inPlan], [], []);
  assert.equal(tree.lanes[0]!.description, 'Claude · lane/111111111111 · Plan: Checkout');
});
