import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, inScope, loadHelperChecks, helperPrompt } from '../src/core/helperService';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import { claudeHelperArguments, codexHelperArguments } from '../src/core/helperRunner';
import { supportedCliVersion, supportedCliVersionIn } from '../src/core/cliVersions';

/** A scripted stand-in for a helper process. It talks to Hydra only through the real endpoint, with its own token. */
type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; endTurn: () => void; nextMessage: () => Promise<string>; exit: (code: number) => void; commit: (file: string, text: string) => Promise<void> }) => Promise<void>;

async function fixture(options: { script: Script; checks?: unknown; now?: () => number; maxConcurrent?: number }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-helpers-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (options.checks) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'checks.json'), JSON.stringify(options.checks)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const runs: HelperRunSpec[] = [];
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', worktreeRoot: () => path.join(root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => options.maxConcurrent ?? 2, now: options.now, watchdogMs: 20,
    startRun: spec => {
      runs.push(spec);
      const listeners: (() => void)[] = [], inbox: string[] = [], readers: ((message: string) => void)[] = [];
      let exit!: (code: number) => void; let stopped = false;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = {
        onTurnEnd: listener => { listeners.push(listener); }, exited,
        send: async message => { if (stopped) return false; const reader = readers.shift(); if (reader) reader(message); else inbox.push(message); return true; },
        stop: async () => exit(137),
      };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      // A real helper takes seconds to start; the fake one starts on the next tick.
      setTimeout(() => void options.script({
        spec, exit,
        call: (tool, args = {}) => callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), token, tool, args),
        endTurn: () => { for (const listener of listeners) listener(); },
        nextMessage: () => inbox.length ? Promise.resolve(inbox.shift()!) : new Promise(resolve => readers.push(resolve)),
        commit: async (file, text) => { await mkdir(path.dirname(path.join(spec.worktree, file)), { recursive: true }); await writeFile(path.join(spec.worktree, file), text); await git(spec.worktree, ['add', '.']); await git(spec.worktree, ['commit', '-qm', `head: ${file}`]); },
      }).catch(() => undefined), 0);
      return run;
    },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = async (key: string, extra: Record<string, unknown> = {}): Promise<any> => (await call('hydra_start_head', { title: `Job ${key}`, brief: 'Do the thing.', write_scope: ['src/'], idempotency_key: key, ...extra })).result;
  const wait = async (ids: string[], max = 90): Promise<any> => (await call('hydra_wait_for_heads', { job_ids: ids, max_wait_s: max })).result;
  return { root, repo, store, service, endpoint, runs, call, start, wait, close: async () => { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

/** Wait for a condition instead of sleeping a fixed time; creating a worktree is slow on Windows. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

const passCheck = { checks: [{ id: 'unit', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/fixed.ts') ? 0 : 1)"], timeoutSeconds: 60 }] };

test('a head that commits in scope and reports done is checked and handed back to the lead', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const reported = await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    assert.equal(reported.result.accepted, true);
    helper.endTurn();
  } });
  try {
    const started = await f.start('happy');
    assert.equal(started.created, true); assert.match(started.base_commit, /^[a-f0-9]{40}$/);
    const again = await f.start('happy');
    assert.equal(again.job_id, started.job_id); assert.equal(again.created, false, 'a repeated idempotency key never starts a second head');
    const waited = await f.wait([started.job_id]);
    assert.equal(waited.all_settled, true);
    const [helper] = waited.heads;
    assert.equal(helper.state, 'done'); assert.equal(helper.summary, 'Added fixed.ts');
    assert.deepEqual(helper.changed_files, ['src/fixed.ts']); assert.equal(helper.checks[0].passed, true);
    assert.match(helper.branch, /^agent\/job-happy-/);
    assert.equal(f.runs.length, 1, 'one head process');
    assert.match(f.runs[0]!.prompt, /Never stop without calling hydra_done or hydra_stuck/);
    assert.match(f.runs[0]!.prompt, /You may change only these paths: src\//);
  } finally { await f.close(); }
});

test('failed checks re-prompt the head, which fixes and passes; the third failure fails the job', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    const first = await helper.call('hydra_done', { summary: 'First try' });
    assert.equal(first.result.accepted, false); assert.match(first.result.message, /Checks failed/); assert.equal(first.result.attempts_left, 2);
    await helper.commit('src/fixed.ts', 'fixed\n');
    const second = await helper.call('hydra_done', { summary: 'Fixed it' });
    assert.equal(second.result.accepted, true);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('retry');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'done'); assert.equal(helper.attempts, 2);
  } finally { await f.close(); }
  const never = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    for (let attempt = 1; attempt <= 3; attempt++) { const result = await helper.call('hydra_done', { summary: `try ${attempt}` }); if (attempt < 3) assert.equal(result.result.accepted, false); else assert.match(result.result.message, /last attempt/); }
  } });
  try {
    const { job_id } = await never.start('never');
    const [helper] = (await never.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /Checks failed 3 times/);
  } finally { await never.close(); }
});

test('Hydra commits leftover changes; no changes and changes outside the write scope are refused', async () => {
  const f = await fixture({ script: async helper => {
    const empty = await helper.call('hydra_done', { summary: 'nothing' });
    assert.match(empty.result.message, /not changed anything yet/);
    // Left uncommitted (a sandboxed Codex helper can't commit): Hydra commits it.
    await writeFile(path.join(helper.spec.worktree, 'src', 'dirty.ts'), 'x');
    await writeFile(path.join(helper.spec.worktree, 'README.md'), 'outside\n');
    const refused = await helper.call('hydra_done', { summary: 'outside' });
    assert.equal(refused.result.accepted, false); assert.match(refused.result.message, /outside your write scope[\s\S]*README\.md/);
    assert.match(await git(helper.spec.worktree, ['log', '-1', '--format=%s']), /Job scope \(Hydra head [a-f0-9]{12}\)/);
    await git(helper.spec.worktree, ['rm', '-q', 'README.md']); await git(helper.spec.worktree, ['commit', '-qm', 'undo']);
    assert.equal((await helper.call('hydra_done', { summary: 'clean' })).result.accepted, true);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('scope');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'done'); assert.deepEqual(helper.changed_files, ['src/dirty.ts']);
  } finally { await f.close(); }
});

test('a head that stops without reporting is nudged once, then failed; one that exits is failed', async () => {
  const f = await fixture({ script: async helper => {
    helper.endTurn();
    const nudge = await helper.nextMessage();
    assert.match(nudge, /stopped without reporting/);
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('silent');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /without calling hydra_done/);
  } finally { await f.close(); }
  const crash = await fixture({ script: async helper => { helper.exit(3); } });
  try {
    const { job_id } = await crash.start('crash');
    const [helper] = (await crash.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /exited \(code 3\)/);
  } finally { await crash.close(); }
});

test('the time limit stops a head, and time spent waiting for an answer does not count', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock, script: async () => { /* works forever */ } });
  try {
    const { job_id } = await f.start('slow', { limits: { wall_clock_minutes: 1 } });
    await until(() => f.store.get(job_id)?.state === 'running' && f.runs.length === 1, 'head process started');
    clock += 61_000;
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /Time limit reached \(1 minutes/);
  } finally { await f.close(); }
});

test('a stuck head waits for the lead, gets the answer as its tool result and continues', async () => {
  const f = await fixture({ script: async helper => {
    const answer = await helper.call('hydra_stuck', { reason: 'Two APIs exist', question: 'Use v1 or v2?' });
    assert.deepEqual(answer.result, { answered: true, answer: 'v2' });
    await helper.commit('src/v2.ts', 'v2\n');
    await helper.call('hydra_done', { summary: 'Used v2' });
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('stuck');
    const blocked = (await f.wait([job_id])).heads[0];
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.question, 'Use v1 or v2?');
    assert.match((await f.call('hydra_reply_to_head', { job_id, message: '' })).error || '', /1–8000/);
    assert.deepEqual((await f.call('hydra_reply_to_head', { job_id, message: 'v2' })).result, { job_id, delivered: true });
    const done = (await f.wait([job_id])).heads[0];
    assert.equal(done.state, 'done'); assert.equal(done.summary, 'Used v2');
    assert.match((await f.call('hydra_reply_to_head', { job_id, message: 'late' })).error || '', /not waiting for an answer/);
  } finally { await f.close(); }
});

test('cancel and Stop all end heads; a dependency that fails fails its dependents; the queue respects the cap', async () => {
  const f = await fixture({ maxConcurrent: 1, script: async helper => { await helper.call('hydra_progress', { note: `working in ${path.basename(helper.spec.worktree)}` }); } });
  try {
    const first = await f.start('one');
    const second = await f.start('two', { depends_on: [first.job_id] });
    const third = await f.start('three');
    await until(() => f.store.get(first.job_id)?.state === 'running', 'first head running');
    assert.equal(f.store.get(third.job_id)?.state, 'queued', 'only one head runs at a time here');
    assert.deepEqual((await f.call('hydra_cancel_head', { job_id: first.job_id, reason: 'Not needed' })).result, { job_id: first.job_id, state: 'cancelled' });
    const settled = (await f.wait([second.job_id])).heads[0];
    assert.equal(settled.state, 'failed'); assert.match(settled.reason, /depends on did not finish/);
    await until(() => !['queued', 'starting'].includes(f.store.get(third.job_id)?.state || ''), 'the freed slot goes to the next queued head');
    assert.equal(f.store.get(third.job_id)?.state, 'running', JSON.stringify({ state: f.store.get(third.job_id)?.state, reason: f.store.get(third.job_id)?.reason }));
    assert.equal(await f.service.stopAll(), 1);
    assert.equal(f.store.get(third.job_id)?.state, 'cancelled');
    const listed = (await f.call('hydra_list_heads')).result.heads;
    assert.deepEqual(listed.map((item: { state: string }) => item.state).sort(), ['cancelled', 'cancelled', 'failed']);
    assert.match((await f.call('hydra_get_head', { job_id: 'ffffffffffff' })).error || '', /No head/);
  } finally { await f.close(); }
});

test('the lead is warned when the head cannot see uncommitted changes; checks come only from the lead folder', async () => {
  const f = await fixture({ script: async () => {} });
  try {
    await writeFile(path.join(f.repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const started = await f.start('dirty');
    assert.match(started.warning, /uncommitted changes/);
    await mkdir(path.join(f.repo, '.hydra'), { recursive: true });
    await writeFile(path.join(f.repo, '.hydra', 'checks.json'), JSON.stringify({ checks: [{ command: ['npm', 'test'], timeoutSeconds: 5000, required: false }] }));
    assert.deepEqual(await loadHelperChecks(f.repo), [{ id: 'check-1', command: ['npm', 'test'], timeoutSeconds: 900, required: false }]);
    await writeFile(path.join(f.repo, '.hydra', 'checks.json'), JSON.stringify({ checks: [{ command: 'npm test' }] }));
    await assert.rejects(loadHelperChecks(f.repo), /must be a list/);
  } finally { await f.close(); }
});

test('scope matching, head prompts, runner arguments and the supported CLI range', () => {
  assert.equal(inScope('src/a.ts', ['src/']), true); assert.equal(inScope('src', ['src']), true);
  assert.equal(inScope('srcx/a.ts', ['src']), false); assert.equal(inScope('README.md', ['']), true);
  assert.match(helperPrompt({ id: 'a'.repeat(12), title: 'T', brief: 'B', writeScope: [''], worktree: 'W', branch: 'b', baseCommit: 'c' }), /\(whole repository\)/);
  const spec: HelperRunSpec = { provider: 'claude', executable: 'claude', worktree: 'W', prompt: 'P', maxTurns: 7, maxBudgetUsd: 2, bridge: { command: 'Hydra.exe', args: ['b.cjs'], env: { HYDRA_HELPER_TOKEN: 'secret', HYDRA_HELPER_PORT: '1' } }, logFile: 'l' };
  const claude = claudeHelperArguments(spec);
  for (const expected of ['dontAsk', '--strict-mcp-config', '--max-turns', '7', '--max-budget-usd', '2']) assert.ok(claude.includes(expected), expected);
  assert.ok(claude.some(arg => arg.startsWith('--mcp-config={') && arg.includes('secret')), 'the token travels inline, never in a file');
  assert.ok(!claude.join(' ').includes('WebFetch'), 'heads get no web tools');
  const codex = codexHelperArguments({ ...spec, provider: 'codex' }, 'thread-1');
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', '--json']); assert.ok(codex.includes("approval_policy='never'")); assert.ok(codex.includes('workspace-write'));
  // Only TOML literal strings: a .cmd launcher's PowerShell/cmd layer strips double quotes.
  assert.ok(codex.some(arg => arg === "mcp_servers.hydra.env={ HYDRA_HELPER_TOKEN = 'secret', HYDRA_HELPER_PORT = '1' }"), codex.join(' '));
  assert.ok(!codex.some(arg => arg.includes('"')), 'no double quotes in Codex arguments');
  assert.throws(() => codexHelperArguments({ ...spec, provider: 'codex', worktree: 'W', bridge: { ...spec.bridge, command: "C:/it's/Hydra.exe" } }), /quote/);
  for (const [version, ok] of [['2.1.270 (Claude Code)', true], ['2.1.281', true], ['2.1.269', false], ['2.2.0', false], ['2.1.300-beta.1', false], ['nonsense', false]] as const) assert.equal(supportedCliVersion('claude', version), ok, version);
  assert.equal(supportedCliVersion('codex', 'codex-cli 0.154.3'), true); assert.equal(supportedCliVersion('codex', 'codex-cli 0.147.0-alpha.1.2'), false);
  assert.equal(supportedCliVersionIn('codex', 'codex_cli_rs/0.154.2 (Windows 10.0.26200; x86_64)'), '0.154.2');
});

test('the dashboard\'s head actions are validated messages', async () => {
  const { parseMessage } = await import('../src/core/model');
  assert.deepEqual(parseMessage({ type: 'helperReview', jobId: 'abcdefabcdef' }), { type: 'helperReview', jobId: 'abcdefabcdef' });
  assert.deepEqual(parseMessage({ type: 'helperCancel', jobId: 'abcdefabcdef' }), { type: 'helperCancel', jobId: 'abcdefabcdef' });
  assert.deepEqual(parseMessage({ type: 'helperStopAll' }), { type: 'helperStopAll' });
  assert.throws(() => parseMessage({ type: 'helperLog', jobId: '../../etc' }), /Invalid head job ID/);
  const { readFile } = await import('node:fs/promises');
  const dashboard = await readFile('webview/HelperDashboard.tsx', 'utf8');
  for (const label of ['Review changes', 'Open log', 'Cancel', 'Stop all', 'Needs an answer']) assert.ok(dashboard.includes(label), label);
});

test('the orchestration map draws heads under their repository, with dependencies and a review action', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentMap } = await import('../webview/AgentMap');
  const repository = path.resolve('map-repo');
  const helper = (id: string, state: string, extra: object = {}) => ({ id, title: `Head ${id.slice(0, 2)}`, state, provider: 'claude' as const, createdAt: `2026-09-24T00:00:0${id[0]}.000Z`, changedFiles: 0, checks: [], repository, dependsOn: [] as string[], ...extra });
  const snapshot = { tasks: [], mode: 'agents', repositories: [repository], providers: [], files: [], busy: false,
    helpers: [helper('111111111111', 'running', { branch: 'agent/one-111111111111' }), helper('222222222222', 'blocked', { branch: 'agent/two-222222222222', dependsOn: ['111111111111'], question: 'Which API?' })] } as any;
  const html = renderToStaticMarkup(React.createElement(AgentMap, { snapshot, onSelect: () => {}, onHelper: () => {} }));
  assert.match(html, /0 tasks · 2 heads · 1 working/);
  assert.match(html, /Claude head/); assert.match(html, /agent\/one-111111111111/);
  assert.match(html, /Needs an answer/); assert.match(html, /agent-map-status-attention/);
  assert.match(html, /agent-map-dependency/, 'the dependent head gets an arrow from its dependency');
  assert.match(html, /aria-label="Review Head 22, Claude head, Needs an answer, branch agent\/two-222222222222"/);
  assert.match(html, /agent-map-flow/, 'a working head animates');
});

test('a head records the chat that started it, and is seen as merged once its branch is in the lead folder', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    await helper.call('hydra_done', { summary: 'Added fixed.ts' });
    helper.endTurn();
  } });
  try {
    const chat = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345', provider: 'codex' });
    const started = (await callHelperEndpoint(f.endpoint.port, chat, 'hydra_start_head', { title: 'Merged later', brief: 'Do it.', write_scope: ['src/'], idempotency_key: 'merge', lead_label: 'Checkout refactor' })).result as { job_id: string };
    assert.deepEqual(f.store.get(started.job_id)!.lead, { sessionId: 'abcdef012345', provider: 'codex', label: 'Checkout refactor' });
    const plain = await f.start('no-session');
    assert.equal(f.store.get(plain.job_id)!.lead, undefined, 'a caller without a session records no lead');
    await until(() => f.store.get(started.job_id)?.state === 'done', 'head done');
    await f.service.refreshMerged();
    assert.equal(f.service.isMerged(started.job_id), false, 'done but not merged yet');
    await git(f.repo, ['merge', '-q', '--no-edit', f.store.get(started.job_id)!.branch!]);
    await f.service.refreshMerged();
    assert.equal(f.service.isMerged(started.job_id), true, 'the lead merged it');
  } finally { await f.close(); }
});
