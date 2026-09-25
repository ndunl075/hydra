import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { toHeadCheckView, gateChip as jobsGateChip, type JobCheckResult } from '../src/core/jobs';
import { gateChip } from '../src/core/agentsCanvas';
import { buildEvidenceMarkdown, findingLink, underLogDirectories } from '../src/core/evidence';
import { summarizeGateFailures, flattenGateFailureMessage, gateFailureMessage } from '../src/core/gates';
import { blankGateForm, checksAsGates, formatWidths, gateFromForm, gateToForm, parseWidths, summarizeGate } from '../src/settings/pages/gatesPageHelpers';
import { LaneStore } from '../src/core/lanes';
import { LaneService } from '../src/core/laneService';
import { fakePtyModule } from './lanePtyFake';
import type { GateRuntime } from '../src/core/gates';

// ---- toHeadCheckView / gateChip (docs/Gates_Plan.md, "Head views") ----

const check = (extra: Partial<JobCheckResult> = {}): JobCheckResult => ({ id: 'unit', required: true, passed: true, exitCode: 0, durationMs: 10, outputTail: '', ...extra });

test('toHeadCheckView carries kind/state/required and only includes summary/findings/evidence when present', () => {
  const passed = toHeadCheckView(check());
  assert.deepEqual(passed, { id: 'unit', passed: true, kind: 'command', state: 'passed', required: true });
  const failed = toHeadCheckView(check({ passed: false, kind: 'review', state: 'failed', summary: 'blocker found', findings: [{ severity: 'blocker', note: 'bad', file: 'a.ts', line: 3 }], evidence: ['/tmp/reply.json'] }));
  assert.equal(failed.kind, 'review'); assert.equal(failed.state, 'failed');
  assert.equal(failed.summary, 'blocker found');
  assert.deepEqual(failed.findings, [{ severity: 'blocker', note: 'bad', file: 'a.ts', line: 3 }]);
  assert.deepEqual(failed.evidence, ['/tmp/reply.json']);
  // A result recorded before gates existed (no kind/state): read through the same fallbacks as gateKind/gateState.
  const legacy = toHeadCheckView(check({ passed: false, kind: undefined, state: undefined }));
  assert.equal(legacy.kind, 'command'); assert.equal(legacy.state, 'failed');
});

test('gateChip: text carries the state (icon plus id), colour only adds to it; not-run explains why on hover', () => {
  for (const chipOf of [jobsGateChip, gateChip]) {
    const passed = chipOf(check({ id: 'unit', passed: true, state: 'passed' }));
    assert.equal(passed.label, '✓ unit'); assert.equal(passed.tone, 'good');
    const failed = chipOf(check({ id: 'ui', passed: false, state: 'failed', kind: 'screenshots' }));
    assert.equal(failed.label, '✗ ui'); assert.equal(failed.tone, 'bad');
    const notRun = chipOf(check({ id: 'review', passed: false, state: 'notRun', summary: 'Codex is at its usage limit.' }));
    assert.equal(notRun.label, '– review'); assert.equal(notRun.tone, 'neutral');
    assert.match(notRun.title, /Not run: Codex is at its usage limit\./);
  }
});

// ---- Evidence document builder (docs/Gates_Plan.md, "View evidence") ----

test('buildEvidenceMarkdown: state, summary, output tail, findings as file:line links, and screenshots as images', () => {
  const results: JobCheckResult[] = [
    check({ id: 'unit', kind: 'command', state: 'passed', outputTail: 'PASS 12 tests' }),
    check({
      id: 'review', kind: 'review', state: 'failed', passed: false, required: true, reviewer: 'codex',
      summary: 'One blocker.', findings: [{ severity: 'blocker', note: 'off by one', file: 'src/a.ts', line: 42 }, { severity: 'minor', note: 'nit' }],
    }),
    check({ id: 'ui', kind: 'screenshots', state: 'passed', evidence: ['/logs/run/ui-390.png', '/logs/run/ui.log'] }),
  ];
  const markdown = buildEvidenceMarkdown({ title: 'Add checkout', worktree: '/work/head', logDirectories: ['/logs/run'], results });
  assert.match(markdown, /# Add checkout — gate evidence/);
  assert.match(markdown, /## unit — ✓ Passed \(command\)/);
  assert.match(markdown, /PASS 12 tests/);
  assert.match(markdown, /## review — ✗ Failed \(review, blocked it\)/);
  assert.match(markdown, /Reviewed by Codex\./);
  // On Windows a rooted path gains the current drive (file:///C:/work/...).
  assert.match(markdown, /\*\*blocker\*\* \[src\/a\.ts:42\]\(file:\/\/\/(?:[A-Za-z]:\/)?work\/head\/src\/a\.ts#42\)/);
  assert.match(markdown, /\*\*minor\*\* \(no location\) — nit/);
  assert.match(markdown, /## ui — ✓ Passed \(screenshots\)/);
  assert.match(markdown, /!\[ui-390\.png\]\(file:\/\/\/(?:[A-Za-z]:\/)?logs\/run\/ui-390\.png\)/);
  assert.match(markdown, /\[ui\.log\]\(file:\/\/\/(?:[A-Za-z]:\/)?logs\/run\/ui\.log\)/);
});

test('buildEvidenceMarkdown: no results is a plain "no gates have run" document', () => {
  assert.match(buildEvidenceMarkdown({ title: 'Lane 1', worktree: '/w', logDirectories: [], results: [] }), /No gates have run\./);
});

test('underLogDirectories accepts only paths under the given directories; evidence outside them is dropped, never linked', () => {
  assert.equal(underLogDirectories('/logs/run/a.png', ['/logs/run']), true);
  assert.equal(underLogDirectories(path.join('/logs/run', 'sub', 'a.png'), ['/logs/run']), true);
  assert.equal(underLogDirectories('/etc/passwd', ['/logs/run']), false);
  assert.equal(underLogDirectories('/logs/runaway/a.png', ['/logs/run']), false, 'a sibling that merely shares a prefix is not "under" it');
  const markdown = buildEvidenceMarkdown({
    title: 'Lane 1', worktree: '/w', logDirectories: ['/logs/run'],
    results: [check({ id: 'ui', kind: 'screenshots', evidence: ['/etc/passwd', '/logs/run/ok.png'] })],
  });
  assert.doesNotMatch(markdown, /passwd/);
  assert.match(markdown, /ok\.png/);
});

test('findingLink: a finding with a file (and optional line) opens it in the given worktree; without a file it is plain text', () => {
  assert.match(findingLink({ severity: 'major', note: 'x', file: 'src/a.ts', line: 7 }, '/work/head'), /^\[src\/a\.ts:7\]\(file:\/\/\/(?:[A-Za-z]:\/)?work\/head\/src\/a\.ts#7\)$/);
  assert.equal(findingLink({ severity: 'major', note: 'x' }, '/work/head'), '(no location)');
});

// ---- Lane merge/run-gates text (docs/Gates_Plan.md, "Merge") ----

test('summarizeGateFailures: one short line per blocking gate, for the merge/run-gates modal', () => {
  const results: JobCheckResult[] = [
    check({ id: 'unit', state: 'failed', passed: false, exitCode: 1 }),
    check({ id: 'review', kind: 'review', state: 'failed', passed: false, findings: [{ severity: 'blocker', note: 'x' }, { severity: 'major', note: 'y' }] }),
    check({ id: 'ui', kind: 'screenshots', state: 'notRun', required: false, summary: 'skipped' }),
  ];
  assert.equal(summarizeGateFailures(results), 'unit (command): exit 1\nreview (review): 2 findings');
});

test('flattenGateFailureMessage: gateFailureMessage collapsed to one line, no line breaks, capped at ~1500 characters', () => {
  const results: JobCheckResult[] = [check({ id: 'unit', state: 'failed', passed: false, exitCode: 1, outputTail: 'line one\nline two\n'.repeat(200) })];
  const flat = flattenGateFailureMessage(results);
  assert.doesNotMatch(flat, /\n/);
  assert.ok(flat.length <= 1500);
  assert.match(flat, /^These gates failed:/);
  assert.match(gateFailureMessage(results), /\n/, 'the un-flattened message is still multi-line');
  const short = flattenGateFailureMessage([check({ id: 'unit', state: 'failed', passed: false, exitCode: 1 })]);
  assert.ok(!short.endsWith('…'), 'a short message is not truncated');
});

// ---- Settings -> Gates page model (docs/Gates_Plan.md, "Hydra Settings -> Gates") ----

test('gatesPageHelpers: form <-> Gate round trip for each gate type', () => {
  const command = { id: 'unit', type: 'command' as const, required: true, command: ['npm', 'test'], timeoutSeconds: 300 };
  assert.deepEqual(gateFromForm(gateToForm(command)), command);
  const screenshots = { id: 'ui', type: 'screenshots' as const, required: false, start: ['npm', 'run', 'dev'], url: 'http://localhost:{port}/', widths: [390, 1280], readyTimeoutSeconds: 60 };
  assert.deepEqual(gateFromForm(gateToForm(screenshots)), screenshots);
  const review = { id: 'review', type: 'review' as const, required: true, reviewer: 'codex' as const, focus: 'security' };
  assert.deepEqual(gateFromForm(gateToForm(review)), review);
  assert.equal(gateFromForm(blankGateForm).type, 'command');
});
test('gatesPageHelpers: widths and row summaries', () => {
  assert.deepEqual(parseWidths('390, 768,  1280'), [390, 768, 1280]);
  assert.deepEqual(parseWidths('390\n768'), [390, 768]);
  assert.equal(formatWidths([390, 768]), '390, 768');
  assert.equal(summarizeGate({ id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 60 }), 'npm test');
  assert.match(summarizeGate({ id: 'review', type: 'review', required: true, reviewer: 'other', focus: '' }), /the other agent/);
});
test('gatesPageHelpers: .hydra/checks.json checks read as command gates, the same reading loadGates gives a head', () => {
  const gates = checksAsGates([{ id: 'unit', command: ['npm', 'test'], timeoutSeconds: 120, required: true }]);
  assert.deepEqual(gates, [{ id: 'unit', type: 'command', required: true, command: ['npm', 'test'], timeoutSeconds: 120 }]);
});

// ---- SSR: gate chips on the canvas and on lane tiles (docs/Gates_Plan.md, "Seeing results") ----

test('SSR: the canvas shows gate chips (passed, failed and not-run) with text, not colour alone', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsCanvas } = await import('../webview/AgentsCanvas');
  const heads = [{
    id: 'aaaaaaaaaaaa', title: 'Add checkout', state: 'done', provider: 'claude' as const, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    changedFiles: 2, dependsOn: [],
    checks: [
      { id: 'unit', passed: true, kind: 'command' as const, state: 'passed' as const, required: true },
      { id: 'review', passed: false, kind: 'review' as const, state: 'failed' as const, required: true },
      { id: 'ui', passed: false, kind: 'screenshots' as const, state: 'notRun' as const, required: false, summary: 'Chrome was not found.' },
    ],
  }];
  const html = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads, onAction: () => {} }));
  assert.match(html, /class="gate-chip tone-good"[^>]*>✓ unit/);
  assert.match(html, /class="gate-chip tone-bad"[^>]*>✗ review/);
  assert.match(html, /class="gate-chip tone-neutral"[^>]*title="Not run: Chrome was not found\."[^>]*>– ui/);
});

test('SSR: a lane tile with a finished gates run shows its chips', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanesView } = await import('../webview/LanesView');
  const lane = {
    id: '111111111111', name: 'Lane 1', provider: 'claude' as const, repository: '/repo', worktree: '/repo.worktrees/1', branch: 'lane/one', baseCommit: 'a'.repeat(40),
    target: 'main', createdAt: new Date().toISOString(), state: 'running' as const, running: true,
    lastGates: { source: 'gates' as const, at: new Date().toISOString(), results: [check({ id: 'unit', state: 'passed' })] },
  };
  const html = renderToStaticMarkup(React.createElement(LanesView, { lanes: [lane], terminals: true, onSend: () => {}, onFocused: () => {} }));
  assert.match(html, /class="gate-chip tone-good"[^>]*>✓ unit/);
});

// ---- LaneService.runGates (docs/Gates_Plan.md, "Lanes": Run gates, progress, cancel) ----

async function laneRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-lanegates-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  return { root, repo, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
function fakeGatesRuntime(run: (id: string) => Promise<{ exitCode: number }>): Partial<GateRuntime> {
  return {
    pollMs: 5,
    runCommand: async (command, _cwd, _logFile, _timeoutMs, signal) => {
      if (signal?.aborted) return { exitCode: null, unavailable: false, interrupted: true, timedOut: false, logFailed: false, logged: false };
      const { exitCode } = await run(command.args[0] || command.executable);
      return { exitCode, unavailable: false, interrupted: false, timedOut: false, logFailed: false, logged: true };
    },
  };
}
async function makeLaneService(repo: string, root: string, gatesRuntime: Partial<GateRuntime>) {
  const store = new LaneStore(path.join(root, 'store'));
  await store.load();
  const pty = fakePtyModule();
  const service = new LaneService({
    store, repository: repo, worktreeRoot: () => undefined, pty,
    executable: async () => 'true', connected: async () => true,
    bridge: () => ({ command: 'node', args: [], env: {} }),
    helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'cfg'),
    testCommand: () => 'true',
    gatesExecutable: async provider => `fake-${provider}`,
    gatesLogDirectory: path.join(root, 'gateslogs'),
    gatesRuntime,
  });
  return { service, pty };
}

test('LaneService.runGates: runs this project\'s gates.json against the lane, reports progress, and records lastGates', async () => {
  const { repo, root, close } = await laneRepo();
  try {
    await mkdir(path.join(repo, '.hydra'), { recursive: true });
    await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify({ lanes: 'onMerge', gates: [{ id: 'unit', type: 'command', command: ['unit'], required: true }, { id: 'lint', type: 'command', command: ['lint'], required: true }] }));
    const { service } = await makeLaneService(repo, root, fakeGatesRuntime(async () => ({ exitCode: 0 })));
    const lane = await service.create({ name: 'Lane 1', provider: 'claude' });
    const progress: { done: string[]; running?: string }[] = [];
    const outcome = await service.runGates(lane.id, update => progress.push({ done: update.done.map(result => result.id), running: update.running }));
    assert.equal(outcome.source, 'gates');
    assert.deepEqual(outcome.results.map(result => [result.id, result.state]), [['unit', 'passed'], ['lint', 'passed']]);
    assert.deepEqual(outcome.failed, []);
    // Progress announces each gate starting, then the final call has both done and no "running".
    assert.ok(progress.some(update => update.running === 'unit'));
    assert.ok(progress.some(update => update.running === 'lint'));
    const last = progress.at(-1)!;
    assert.equal(last.running, undefined);
    assert.deepEqual(last.done, ['unit', 'lint']);
    const stored = service.get(lane.id);
    assert.equal(stored?.lastGates?.source, 'gates');
    assert.equal(stored?.lastGates?.results.length, 2);
  } finally { await close(); }
});

test('LaneService.runGates: a second call cancels a run already in progress (AbortSignal)', async () => {
  const { repo, root, close } = await laneRepo();
  try {
    await mkdir(path.join(repo, '.hydra'), { recursive: true });
    await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify({ gates: [{ id: 'slow', type: 'command', command: ['slow'] }] }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { service } = await makeLaneService(repo, root, fakeGatesRuntime(async id => { if (id === 'slow') await gate; return { exitCode: 0 }; }));
    const lane = await service.create({ name: 'Lane 1', provider: 'claude' });
    const first = service.runGates(lane.id).catch(error => error as Error);
    await new Promise(resolve => setTimeout(resolve, 20));
    service.cancelGates(lane.id);
    release?.();
    const result = await first;
    assert.ok(result instanceof Error);
    assert.match((result as Error).message, /cancelled/i);
  } finally { await close(); }
});

test('LaneService: "Send to lane" writes to the terminal without a trailing carriage return (never presses Enter)', async () => {
  const { repo, root, close } = await laneRepo();
  try {
    const { service, pty } = await makeLaneService(repo, root, {});
    const lane = await service.create({ name: 'Lane 1', provider: 'claude' });
    const results: JobCheckResult[] = [check({ id: 'unit', state: 'failed', passed: false, exitCode: 1 })];
    const wrote = service.input(lane.id, flattenGateFailureMessage(results));
    assert.equal(wrote, true);
    const written = pty.spawned[0]!.written.join('');
    assert.ok(written.length > 0);
    assert.ok(!written.includes('\r'), 'Send to lane never presses Enter');
    assert.match(written, /These gates failed/);
  } finally { await close(); }
});
