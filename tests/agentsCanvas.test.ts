import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildCanvas, elapsedLabel, finishedLingerMs, layout, onCanvas, trayWindowMs } from '../src/core/agentsCanvas';
import type { HelperJobView } from '../src/core/model';
import { createPlan, type Plan, type PlanJob } from '../src/core/plans';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const head = (id: string, state: string, extra: Partial<HelperJobView> = {}): HelperJobView => ({
  id, title: `Head ${id}`, state, provider: 'claude', createdAt: at(60_000), changedFiles: 0, checks: [], dependsOn: [], ...extra,
});
const planJob = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });
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
  assert.match(idle, /Heads your Claude Code and Codex chats start will appear here\./);
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
});

test('buildCanvas only draws a lead node for a plan still being drafted; a running or done plan\'s heads group under the ordinary lead', () => {
  const running = plan('running', [planJob('api', { jobId: '111111111111' })]);
  const withRunningHead = buildCanvas([head('111111111111', 'running', { lead: { sessionId: `plan-${running.id}`, label: `Plan · ${running.title}` } })], now, { plans: [running] });
  assert.deepEqual(withRunningHead.plans, [], 'a running plan has no draft node of its own');
  assert.deepEqual(withRunningHead.leads.map(lead => lead.label), [`Plan · ${running.title}`], 'its heads group under an ordinary lead instead');

  const done = plan('done', [planJob('api', { jobId: '222222222222' })]);
  assert.deepEqual(buildCanvas([], now, { plans: [done] }).plans, [], 'a done plan is not drawn either');

  const planning = plan('planning', []);
  assert.equal(buildCanvas([], now, { plans: [planning] }).plans.length, 1, 'a plan still being drafted is drawn');
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
