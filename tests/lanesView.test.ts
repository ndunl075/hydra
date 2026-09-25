import test from 'node:test';
import assert from 'node:assert/strict';
import type { LaneView } from '../src/core/model';

const lane = (id: string, name: string, extra: Partial<LaneView> = {}): LaneView => ({
  id, name, provider: 'claude', repository: '/repo', worktree: `/repo.worktrees/${id}`, branch: `lane/${id}`, baseCommit: 'a'.repeat(40),
  target: 'main', createdAt: new Date().toISOString(), state: 'running', running: true, ...extra,
});

test('an SSR render of the Lanes view shows the toolbar, tiles, their chips, and the exited overlay', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanesView } = await import('../webview/LanesView');
  const lanes = [
    lane('111111111111', 'Lane 1', { branch: 'lane/checkout', sync: { changedFiles: ['a.ts', 'b.ts'], conflicts: [{ laneId: '222222222222', files: ['a.ts'] }], targetConflicts: [], behind: 3, dirty: false, checkedAt: new Date().toISOString() } }),
    lane('222222222222', 'Lane 2', { provider: 'codex', state: 'exited', exitCode: 1 }),
    lane('333333333333', 'Lane 3', { state: 'merged', sync: { changedFiles: ['c.ts'], conflicts: [], targetConflicts: [], behind: 0, dirty: false, checkedAt: new Date().toISOString() } }),
  ];
  const html = renderToStaticMarkup(React.createElement(LanesView, { lanes, terminals: true, onSend: () => {}, onFocused: () => {} }));
  assert.match(html, /New lane/);
  assert.match(html, /Lane 1/); assert.match(html, /Lane 2/); assert.match(html, /Lane 3/);
  assert.match(html, /lane\/checkout/);
  assert.match(html, /Conflicts with Lane 2/);
  assert.match(html, /3 behind main/);
  assert.match(html, /Merges cleanly/);
  assert.match(html, /Merged/);
  assert.match(html, /Session ended \(code 1\)/);
  assert.match(html, /Resume/); assert.match(html, /Start fresh/);
  assert.match(html, /files? changed/);
  assert.match(html, /class="lane-tile"/);
});

test('an SSR render shows the "Terminals aren\'t available" state instead of a grid when terminals is false', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanesView } = await import('../webview/LanesView');
  const html = renderToStaticMarkup(React.createElement(LanesView, { lanes: [lane('111111111111', 'Lane 1')], terminals: false, onSend: () => {}, onFocused: () => {} }));
  assert.match(html, /Terminals aren.{1,6}t available in this build./);
  assert.doesNotMatch(html, /class="lane-tile"/);
});

test('an SSR render of the New lane form shows the name, agent choice and goal, and an inline error', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NewLaneCard } = await import('../webview/LanesView');
  const html = renderToStaticMarkup(React.createElement(NewLaneCard, { initial: { name: 'Lane 1', provider: 'claude', goal: '' }, error: 'Claude Code CLI not found.', onStart: () => {}, onCancel: () => {} }));
  assert.match(html, /Name/); assert.match(html, /Claude Code/); assert.match(html, /Codex/); assert.match(html, /Goal, optional/);
  assert.match(html, /Start lane/);
  assert.match(html, /Claude Code CLI not found\./);
});

test('an empty Lanes view (no lanes yet) still renders the toolbar and a hint, not an empty grid crash', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanesView } = await import('../webview/LanesView');
  const html = renderToStaticMarkup(React.createElement(LanesView, { lanes: [], terminals: true, onSend: () => {}, onFocused: () => {} }));
  assert.match(html, /No lanes yet\./);
});

test('an SSR render of the Canvas | Lanes switch shows both tabs, the lane count, and hides the inactive pane (both stay mounted)', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsBody } = await import('../webview/AgentsBody');
  const lanes = [lane('111111111111', 'Lane 1')];
  const panesOf = (html: string) => html.split('<div class="agents-view-pane"').slice(1).map(chunk => chunk.slice(0, chunk.indexOf('>')));

  const canvasHtml = renderToStaticMarkup(React.createElement(AgentsBody, {
    view: 'canvas', onViewChange: () => {}, heads: [], lanes, terminals: true, onLaneFocused: () => {},
    onAction: () => {}, onOpenLane: () => {}, onSend: () => {},
  }));
  assert.match(canvasHtml, /role="tab"[^>]*>Canvas/);
  assert.match(canvasHtml, /Lanes <span class="agents-view-count">1<\/span>/);
  assert.match(canvasHtml, /agents-canvas/, 'the canvas pane renders when view is canvas');
  const canvasPanes = panesOf(canvasHtml);
  assert.equal(canvasPanes.length, 2);
  assert.doesNotMatch(canvasPanes[0]!, /hidden=""/, 'the canvas pane is visible');
  assert.match(canvasPanes[1]!, /hidden=""/, 'the Lanes pane is present but hidden');

  const lanesHtml = renderToStaticMarkup(React.createElement(AgentsBody, {
    view: 'lanes', onViewChange: () => {}, heads: [], lanes, terminals: true, onLaneFocused: () => {},
    onAction: () => {}, onOpenLane: () => {}, onSend: () => {},
  }));
  const lanesPanes = panesOf(lanesHtml);
  assert.match(lanesPanes[0]!, /hidden=""/, 'the canvas pane is hidden while Lanes is active');
  assert.doesNotMatch(lanesPanes[1]!, /hidden=""/);
  assert.match(lanesHtml, /class="lanes-view"/);
});
