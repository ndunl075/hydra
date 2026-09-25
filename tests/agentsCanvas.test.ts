import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCanvas, elapsedLabel, finishedLingerMs, layout, onCanvas, trayWindowMs } from '../src/core/agentsCanvas';
import type { HelperJobView, LaneView } from '../src/core/model';
import { createPlan, type Plan, type PlanJob } from '../src/core/plans';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const head = (id: string, state: string, extra: Partial<HelperJobView> = {}): HelperJobView => ({
  id, title: `Head ${id}`, state, provider: 'claude', createdAt: at(60_000), changedFiles: 0, checks: [], dependsOn: [], ...extra,
});
const planJob = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });
const lane = (id: string, name: string, extra: Partial<LaneView> = {}): LaneView => ({
  id, name, provider: 'claude', repository: '/repo', worktree: `/repo.worktrees/${id}`, branch: `lane/${id}`, baseCommit: 'a'.repeat(40),
  target: 'main', createdAt: at(60_000), state: 'running', running: true, ...extra,
});
const plan = (state: Plan['state'], jobs: PlanJob[] = [], extra: Partial<Plan> = {}): Plan => ({ ...createPlan({ title: 'Checkout refactor', brief: 'Refactor checkout.' }), state, jobs, ...extra });

test('the canvas shows working heads and fresh results; merged heads leave; old results move to the tray', () => {
  assert.equal(onCanvas(head('a', 'running'), now), true);
  assert.equal(onCanvas(head('b', 'queued'), now), true);
  assert.equal(onCanvas(head('c', 'done', { finishedAt: at(10_000) }), now), true, 'a fresh result stays so you see it');
  assert.equal(onCanvas(head('d', 'done', { finishedAt: at(10_000), merged: true }), now), false, 'merged heads leave at once');
  assert.equal(onCanvas(head('e', 'failed', { finishedAt: at(finishedLingerMs + 1) }), now), false);
  const model = buildCanvas([
    head('e', 'failed', { finishedAt: at(finishedLingerMs + 1) }),
    head('f', 'done', { finishedAt: at(finishedLingerMs + 5_000) }),
    head('g', 'done', { finishedAt: at(trayWindowMs + 1) }),
    head('h', 'done', { finishedAt: at(finishedLingerMs + 5_000), merged: true }),
  ], now);
  assert.deepEqual(model.heads, [], 'blank when nothing is working');
  assert.deepEqual(model.leads, []);
  assert.deepEqual(model.tray.map(item => item.id), ['e', 'f'], 'unmerged results from today, newest first; merged and old ones are gone');
});

test('heads group under the chat that started them, and dependents sit to the right of what they wait on', () => {
  const claudeChat = { sessionId: '111111111111', provider: 'claude' as const, label: 'Checkout refactor' };
  const codexChat = { sessionId: '222222222222', provider: 'codex' as const };
  const model = buildCanvas([
    head('api', 'running', { lead: claudeChat, createdAt: at(50_000) }),
    head('ui', 'running', { lead: claudeChat, createdAt: at(40_000) }),
    head('tests', 'queued', { lead: claudeChat, createdAt: at(30_000), dependsOn: ['api', 'ui'] }),
    head('docs', 'checking', { lead: codexChat, provider: 'codex', createdAt: at(20_000) }),
    head('legacy', 'running', { createdAt: at(10_000) }),
  ], now);
  assert.deepEqual(model.leads.map(lead => [lead.key, lead.label, lead.heads.length]), [
    ['111111111111', 'Checkout refactor', 3],
    ['222222222222', `Codex chat · ${new Date(at(20_000)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 1],
    ['window', 'This window', 1],
  ]);
  const pos = Object.fromEntries(model.heads.map(item => [item.id, item]));
  assert.equal(pos.api!.x, layout.headX); assert.equal(pos.ui!.x, layout.headX);
  assert.equal(pos.tests!.x, layout.headX + layout.columnGap, 'tests waits for api and ui, so it sits one column right');
  assert.notEqual(pos.api!.y, pos.ui!.y);
  // A head card is about 150px tall (header, title, two-line note, footer); rows must clear it.
  assert.ok(Math.abs(pos.api!.y - pos.ui!.y) >= 160, 'cards in a column never overlap');
  assert.ok(pos.docs!.y > Math.max(pos.api!.y, pos.ui!.y, pos.tests!.y), 'the next chat stacks below');
  const edges = Object.fromEntries(model.edges.map(edge => [edge.id, edge]));
  assert.equal(edges['111111111111>api']!.kind, 'lead');
  assert.equal(edges['api>tests']!.kind, 'dependency'); assert.equal(edges['api>tests']!.waiting, true, 'tests is still waiting on api');
  assert.equal(edges['111111111111>tests'], undefined, 'a dependent hangs off its dependencies, not the chat');
  assert.equal(edges['222222222222>docs']!.active, true);
  // Same input, same layout: nothing jitters between updates.
  assert.deepEqual(buildCanvas(model.heads.map(item => item.head), now).heads.map(item => [item.id, item.x, item.y]), model.heads.map(item => [item.id, item.x, item.y]));
});

test('elapsed time reads naturally and stops when a head finishes', () => {
  assert.equal(elapsedLabel(head('a', 'running', { startedAt: at(42_000) }), now), '42s');
  assert.equal(elapsedLabel(head('a', 'running', { startedAt: at(125_000) }), now), '2m 05s');
  assert.equal(elapsedLabel(head('a', 'done', { startedAt: at(4_000_000), finishedAt: at(3_700_000) }), now), '5m 00s');
});

test('the canvas renders chats, heads, dependency edges and an accessible label; blank when idle', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsCanvas } = await import('../webview/AgentsCanvas');
  const lead = { sessionId: '111111111111', provider: 'claude' as const, label: 'Checkout refactor' };
  const heads = [
    head('111111111111', 'running', { lead, createdAt: new Date().toISOString(), progress: 'Wiring the CSV writer', branch: 'agent/csv-111111111111' }),
    head('222222222222', 'blocked', { lead, createdAt: new Date().toISOString(), dependsOn: ['111111111111'], question: 'Which API?' }),
  ];
  const html = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads, onAction: () => {} }));
  assert.match(html, /Checkout refactor/);
  assert.match(html, /Wiring the CSV writer/);
  assert.match(html, /Asks: Which API\?/);
  assert.match(html, /canvas-edge dependency/);
  assert.match(html, /class="flow"/, 'a working head animates its edge');
  assert.match(html, /aria-label="Head 222222222222, Claude head, Needs an answer\. Asks: Which API\?\. Enter opens the diff; Shift\+F10 for more\."/);
  assert.match(html, /tabindex="0"/);
  const idle = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], onAction: () => {} }));
  assert.match(idle, /Lanes you open, plans you draft and heads your chats start will appear here\./);
  assert.doesNotMatch(idle, /canvas-node/);
});

test('the Agents view offers only head actions: diff, log, answer, cancel and stop all', async () => {
  const { parseMessage } = await import('../src/core/model');
  for (const type of ['helperReview', 'helperLog', 'helperCancel', 'helperAnswer'] as const) assert.deepEqual(parseMessage({ type, jobId: 'abcdefabcdef' }), { type, jobId: 'abcdefabcdef' });
  assert.throws(() => parseMessage({ type: 'helperAnswer', jobId: '../../etc' }), /Invalid head job ID/);
  const [canvas, css, page] = await Promise.all([readFile('webview/AgentsCanvas.tsx', 'utf8'), readFile('webview/agents-canvas.css', 'utf8'), readFile('webview/index.tsx', 'utf8')]);
  for (const label of ['Open diff', 'Open log', 'Answer question', 'Cancel head', 'Stop all heads', 'Pause motion']) assert.ok(canvas.includes(label), label);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /body\.vscode-high-contrast/);
  assert.match(css, /\.canvas-node:focus-visible/);
  // The task-era panels are gone from the Agents view.
  for (const retired of ['task-rail', 'Resources and setup', 'Managed CLI', 'profile slots', 'Create task']) assert.ok(!page.includes(retired), retired);
});

// ---- Lanes (docs/Lanes_And_Planner_Plan.md, section 2): its own block. ----

test('buildCanvas draws every open lane as a lead node, even with no heads; closed and merged lanes are hidden', () => {
  const model = buildCanvas([], now, { lanes: [lane('111111111111', 'Lane 1'), lane('222222222222', 'Lane 2', { state: 'exited', exitedAt: at(60_000) }), lane('333333333333', 'Lane 3', { state: 'merged' }), lane('444444444444', 'Lane 4', { state: 'closed' })] });
  const keys = model.leads.map(item => item.key);
  assert.ok(keys.includes('111111111111') && keys.includes('222222222222'));
  assert.ok(!keys.includes('333333333333') && !keys.includes('444444444444'), 'a merged or closed lane is not drawn');
  const running = model.leads.find(item => item.key === '111111111111')!;
  assert.equal(running.kind, 'lane'); assert.equal(running.label, 'Lane 1'); assert.equal(running.status, 'Working · lane/111111111111'); assert.deepEqual(running.heads, []);
  const exited = model.leads.find(item => item.key === '222222222222')!;
  assert.equal(exited.status, 'Exited');
});

test('buildCanvas groups a head under its lane, not a chat lead, when lead.lane is set', () => {
  const model = buildCanvas([head('h1', 'running', { lead: { sessionId: 'sess-1', provider: 'claude', lane: '111111111111' } })], now, { lanes: [lane('111111111111', 'Lane 1')] });
  assert.equal(model.leads.length, 1);
  const laneLead = model.leads[0]!;
  assert.equal(laneLead.key, '111111111111'); assert.equal(laneLead.kind, 'lane'); assert.equal(laneLead.label, 'Lane 1');
  assert.deepEqual(laneLead.heads, ['h1']);
});

test('buildCanvas draws one red dashed conflict edge per conflicting pair of lanes', () => {
  const a = lane('111111111111', 'Lane 1', { sync: { changedFiles: ['a.ts'], conflicts: [{ laneId: '222222222222', files: ['a.ts'] }], targetConflicts: [], behind: 0, dirty: false, checkedAt: at(0) } });
  const b = lane('222222222222', 'Lane 2', { sync: { changedFiles: ['a.ts'], conflicts: [{ laneId: '111111111111', files: ['a.ts'] }], targetConflicts: [], behind: 0, dirty: false, checkedAt: at(0) } });
  const model = buildCanvas([], now, { lanes: [a, b] });
  const conflictEdges = model.edges.filter(edge => edge.kind === 'conflict');
  assert.equal(conflictEdges.length, 1, 'one edge per pair, not one per direction');
  assert.equal(model.leads.find(item => item.key === '111111111111')!.status, 'Conflicts with Lane 2');
});

test('buildCanvas parks an exited lane with no running heads after 10 minutes; a fresh exit or a running head keeps it a full node', () => {
  const quiet = lane('111111111111', 'Lane 1', { state: 'exited', exitedAt: at(9 * 60_000) });
  const parkedYet = buildCanvas([], now, { lanes: [quiet] });
  assert.equal(parkedYet.parkedLanes.length, 0, 'under 10 minutes: still a full node');
  assert.ok(parkedYet.leads.some(item => item.key === '111111111111'));

  const stale = lane('111111111111', 'Lane 1', { state: 'exited', exitedAt: at(11 * 60_000) });
  const parked = buildCanvas([], now, { lanes: [stale] });
  assert.deepEqual(parked.leads, [], 'over 10 minutes: parked, not a lead node');
  assert.deepEqual(parked.parkedLanes.map(item => item.id), ['111111111111']);
  assert.equal(parked.parkedLanes[0]!.conflicts, false);

  // A running head under this lane keeps it a full node even past the window.
  const withRunningHead = buildCanvas([head('h1', 'running', { lead: { sessionId: 'sess', provider: 'claude', lane: '111111111111' } })], now, { lanes: [stale] });
  assert.deepEqual(withRunningHead.parkedLanes, []);
  assert.ok(withRunningHead.leads.some(item => item.key === '111111111111'));

  // A running lane is never parked, however long ago its (stale, ignored) exitedAt claims.
  const stillRunning = lane('222222222222', 'Lane 2', { state: 'running', exitedAt: at(11 * 60_000) });
  assert.deepEqual(buildCanvas([], now, { lanes: [stillRunning] }).parkedLanes, []);

  // Conflicts are marked on the chip.
  const conflicted = lane('333333333333', 'Lane 3', { state: 'exited', exitedAt: at(11 * 60_000), sync: { changedFiles: [], conflicts: [{ laneId: '444444444444', files: ['a.ts'] }], targetConflicts: [], behind: 0, dirty: false, checkedAt: at(0) } });
  assert.equal(buildCanvas([], now, { lanes: [conflicted] }).parkedLanes[0]!.conflicts, true);

  // A lane that exited before exitedAt was recorded has no time: it exited long ago, so it parks.
  const unrecorded = lane('555555555555', 'Lane 5', { state: 'exited' });
  assert.deepEqual(buildCanvas([], now, { lanes: [unrecorded] }).parkedLanes.map(item => item.id), ['555555555555']);
});

test('buildCanvas filters the tray by dismissed ids; a new finished head still shows up', () => {
  const finished = [head('e', 'failed', { finishedAt: at(finishedLingerMs + 1) }), head('f', 'done', { finishedAt: at(finishedLingerMs + 5_000) })];
  const all = buildCanvas(finished, now).tray.map(item => item.id);
  assert.deepEqual(all, ['e', 'f']);
  const filtered = buildCanvas(finished, now, { dismissedTray: new Set(['e']) }).tray.map(item => item.id);
  assert.deepEqual(filtered, ['f'], 'a dismissed id is hidden');
  const fresh = buildCanvas([...finished, head('g', 'done', { finishedAt: at(finishedLingerMs + 10_000) })], now, { dismissedTray: new Set(['e', 'f']) }).tray.map(item => item.id);
  assert.deepEqual(fresh, ['g'], 'a newly finished head still shows up');
});

test('an SSR render shows the Parked lanes strip, the Finished tray Clear button, and the Learn how link', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsCanvas } = await import('../webview/AgentsCanvas');
  // AgentsCanvas keeps its own real-time clock (useState(() => Date.now())), so this test's timestamps
  // must be relative to actual now, unlike buildCanvas's own tests, which pass a fixed `now`.
  const realNow = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const stale = lane('111111111111', 'Lane 1', { state: 'exited', exitedAt: realNow(11 * 60_000) });
  const withTrayAndParked = renderToStaticMarkup(React.createElement(AgentsCanvas, {
    heads: [head('a', 'done', { finishedAt: realNow(finishedLingerMs + 10_000) })], lanes: [stale], onAction: () => {},
  }));
  assert.match(withTrayAndParked, /Parked lanes/);
  assert.match(withTrayAndParked, /Lane 1/);
  assert.match(withTrayAndParked, />Clear</);
  const idle = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], onAction: () => {} }));
  assert.match(idle, /Learn how/);
});

// ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----

test('buildCanvas draws a draft plan as a lead node with dashed jobs, laid out by dependency depth', () => {
  const draft = plan('draft', [planJob('api'), planJob('ui'), planJob('tests', { dependsOn: ['api', 'ui'] })]);
  const model = buildCanvas([], now, { plans: [draft] });
  assert.equal(model.plans.length, 1);
  const node = model.plans[0]!;
  assert.equal(node.plan.id, draft.id);
  assert.equal(node.cycleMessage, undefined);
  const pos = Object.fromEntries(node.jobs.map(item => [item.job.key, item]));
  assert.equal(pos.api!.x, layout.headX); assert.equal(pos.ui!.x, layout.headX);
  assert.equal(pos.tests!.x, layout.headX + layout.columnGap, 'tests waits for api and ui, so it sits one column right');
  assert.notEqual(pos.api!.y, pos.ui!.y, 'independent jobs in the same column never overlap');
  const edgeIds = model.edges.map(edge => edge.id);
  assert.ok(edgeIds.includes(`plan-lead:${draft.id}>${pos.api!.id}`));
  assert.ok(edgeIds.includes(`${pos.api!.id}>${pos.tests!.id}`));
  assert.equal(model.edges.find(edge => edge.id === `${pos.api!.id}>${pos.tests!.id}`)!.kind, 'plan-dependency');
});

test('buildCanvas flags a plan\'s cycle edges and names the cycle on the plan node', () => {
  const cyclic = plan('draft', [planJob('a', { dependsOn: ['b'] }), planJob('b', { dependsOn: ['a'] })]);
  const model = buildCanvas([], now, { plans: [cyclic] });
  const node = model.plans[0]!;
  assert.equal(node.cycleMessage, 'The plan has a dependency cycle: Job a → Job b → Job a');
  const cycleEdges = model.edges.filter(edge => edge.kind === 'plan-dependency');
  assert.equal(cycleEdges.length, 2);
  assert.ok(cycleEdges.every(edge => edge.cycle === true));
  assert.equal(Math.min(...node.jobs.map(item => item.x)), layout.headX, 'a cycle still starts in the first column, with no gap');
});

test('buildCanvas draws a lead node for a plan still being drafted; a running plan gets its own running group instead', () => {
  const running = plan('running', [planJob('api', { jobId: '111111111111' })]);
  const withRunningHead = buildCanvas([head('111111111111', 'running', { lead: { sessionId: `plan-${running.id}`, label: `Plan · ${running.title}` } })], now, { plans: [running] });
  assert.equal(withRunningHead.plans.length, 1, 'a running plan gets its own group');
  assert.deepEqual(withRunningHead.leads, [], 'its head does not also group under an ordinary lead');

  const planning = plan('planning', []);
  assert.equal(buildCanvas([], now, { plans: [planning] }).plans.length, 1, 'a plan still being drafted is drawn');
});

test('a done plan leaves the canvas once its heads and lanes are gone, like a chat', () => {
  const done = plan('done', [planJob('api', { jobId: '222222222222' })]);
  assert.deepEqual(buildCanvas([], now, { plans: [done] }).plans, [], 'nothing of it is left to show');
  const stillShowing = buildCanvas([head('222222222222', 'done', { finishedAt: new Date(now - 1000).toISOString() })], now, { plans: [done] });
  assert.equal(stillShowing.plans.length, 1, 'its head is still fresh on the canvas, so the plan lingers');
});

// ---- Plan lanes (docs/Plan_Lanes_Plan.md, section 4): the running plan group. ----

test('buildCanvas groups a running mixed plan: a head slot, a lane-card slot and a waiting slot, with edges between them', () => {
  const running = plan('running', [
    planJob('schema', { jobId: '111111111111' }),
    planJob('build', { runAs: 'lane', laneId: '222222222222', dependsOn: ['schema'] }),
    planJob('deploy', { dependsOn: ['build'] }),
  ]);
  const buildLane: LaneView = lane('222222222222', 'Build API', { state: 'running' });
  const views = {
    [running.id]: [
      { key: 'schema', runAs: 'head' as const, status: 'active' as const, jobId: '111111111111' },
      { key: 'build', runAs: 'lane' as const, status: 'active' as const, laneId: '222222222222' },
      { key: 'deploy', runAs: 'head' as const, status: 'waiting' as const, reason: 'Waiting for Job build' },
    ],
  };
  const model = buildCanvas([head('111111111111', 'running', { lead: { sessionId: `plan-${running.id}` } })], now, { plans: [running], lanes: [buildLane], planJobs: views });
  assert.equal(model.plans.length, 1);
  const node = model.plans[0]!;
  assert.equal(node.plan.id, running.id);
  const byKey = Object.fromEntries(node.jobs.map(item => [item.job.key, item]));
  assert.ok(byKey.schema!.head, 'the head job slot carries its still-on-canvas head');
  assert.equal(byKey.schema!.head!.id, '111111111111');
  assert.ok(byKey.build!.lane, 'the lane job slot carries its open lane');
  assert.equal(byKey.build!.lane!.id, '222222222222');
  assert.equal(byKey.deploy!.view!.status, 'waiting');
  assert.ok(byKey.build!.x > byKey.schema!.x, 'build sits after schema');
  assert.ok(byKey.deploy!.x > byKey.build!.x, 'deploy sits after build');
  const edge = model.edges.find(item => item.id === `${byKey.schema!.id}>${byKey.build!.id}`);
  assert.equal(edge?.kind, 'plan-dependency', 'a head-to-lane dependency edge joins the two slots');
  const edge2 = model.edges.find(item => item.id === `${byKey.build!.id}>${byKey.deploy!.id}`);
  assert.equal(edge2?.kind, 'plan-dependency');
  assert.equal(edge2?.waiting, true, 'deploy waits while build is active');
});

test('a plan lane is not also drawn as a separate lane node', () => {
  const running = plan('running', [planJob('build', { runAs: 'lane', laneId: '222222222222' })]);
  const buildLane: LaneView = lane('222222222222', 'Build API', { state: 'running' });
  const views = { [running.id]: [{ key: 'build', runAs: 'lane' as const, status: 'active' as const, laneId: '222222222222' }] };
  const model = buildCanvas([], now, { plans: [running], lanes: [buildLane], planJobs: views });
  assert.equal(model.leads.filter(lead => lead.kind === 'lane').length, 0, 'no separate lane lead for a plan lane');
  assert.equal(model.plans[0]!.jobs[0]!.lane!.id, '222222222222', 'it is drawn only as the job\'s lane card');
});

test('heads a plan lane starts sit in the column after its lane card, joined by a lead edge', () => {
  const running = plan('running', [planJob('build', { runAs: 'lane', laneId: '222222222222' })]);
  const buildLane: LaneView = lane('222222222222', 'Build API', { state: 'running' });
  const views = { [running.id]: [{ key: 'build', runAs: 'lane' as const, status: 'active' as const, laneId: '222222222222' }] };
  const subHead = head('333333333333', 'running', { lead: { sessionId: 'sub', lane: '222222222222' } });
  const model = buildCanvas([subHead], now, { plans: [running], lanes: [buildLane], planJobs: views });
  const slot = model.plans[0]!.jobs[0]!;
  const drawn = model.heads.find(item => item.id === '333333333333');
  assert.ok(drawn, 'the sub-head is drawn on the canvas');
  assert.ok(drawn!.x > slot.x, 'it sits after the lane\'s slot');
  const edge = model.edges.find(item => item.from === slot.id && item.to === '333333333333');
  assert.equal(edge?.kind, 'plan-lane-head');
});

test('a head that has left the canvas keeps a small done node in its plan job slot', () => {
  const running = plan('running', [planJob('api', { jobId: '111111111111' })]);
  const views = { [running.id]: [{ key: 'api', runAs: 'head' as const, status: 'done' as const, jobId: '111111111111', commit: 'a'.repeat(40) }] };
  // The head finished long ago, so it is off the canvas (in the tray) and out of the group's grouping loop.
  const model = buildCanvas([head('111111111111', 'done', { finishedAt: new Date(now - trayWindowMs / 2).toISOString() })], now, { plans: [running], planJobs: views });
  const slot = model.plans[0]!.jobs[0]!;
  assert.equal(slot.head, undefined, 'the head card itself is gone');
  assert.equal(slot.view!.status, 'done', 'the slot still knows the job is done');
});

test('buildCanvas keeps working with no plans argument at all (existing callers)', () => {
  assert.deepEqual(buildCanvas([], now).plans, []);
});

test('an SSR render shows the New plan card, and a draft, planning and failed plan each in their own state', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsCanvas } = await import('../webview/AgentsCanvas');

  const toolbar = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], onAction: () => {} }));
  assert.match(toolbar, /New plan/);

  const draft = plan('draft', [planJob('api', { provider: 'codex' }), planJob('ui', { dependsOn: ['api'] })]);
  const draftHtml = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [draft], onAction: () => {} }));
  assert.match(draftHtml, new RegExp(`Plan . ${draft.title}`));
  assert.match(draftHtml, /\+ Job/);
  assert.match(draftHtml, /Run plan/);
  assert.match(draftHtml, /Delete plan/);
  assert.match(draftHtml, /Draft job/);
  assert.match(draftHtml, /Job api/);
  assert.match(draftHtml, /2 jobs/);
  assert.match(draftHtml, /canvas-edge plan-lead/, 'the plan node is joined to its first job');

  const planning = plan('planning', []);
  const planningHtml = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [planning], defaultProvider: 'codex', onAction: () => {} }));
  assert.match(planningHtml, /Planning with Codex…/);
  assert.match(planningHtml, />Cancel</);

  const failed = plan('failed', [], { error: 'Codex exited with code 1.' });
  const failedHtml = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [failed], onAction: () => {} }));
  assert.match(failedHtml, /Codex exited with code 1\./);
  assert.match(failedHtml, />Retry</);
  assert.match(failedHtml, /Start empty/);

  const cyclic = plan('draft', [planJob('a', { dependsOn: ['b'] }), planJob('b', { dependsOn: ['a'] })]);
  const cyclicHtml = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [cyclic], onAction: () => {} }));
  assert.match(cyclicHtml, /The plan has a dependency cycle: Job a → Job b → Job a/);
  assert.match(cyclicHtml, /class="canvas-edge plan-dependency cycle"/);
  assert.match(cyclicHtml, /disabled=""[^>]*>Run plan/, 'Run plan is disabled while the plan has a cycle');
});
