import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, inScope, loadHelperChecks, helperPrompt, type HelperServiceOptions } from '../src/core/helperService';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import { claudeHelperArguments, codexHelperArguments } from '../src/core/helperRunner';
import { supportedCliVersion, supportedCliVersionIn } from '../src/core/cliVersions';
import type { HeadLimit } from '../src/core/limitDetection';
import type { LimitEvent } from '../src/core/limitEvents';
import type { ReviewerSpec } from '../src/core/gates';
import { dependencyBrief, maxDependencyBrief } from '../src/core/headStart';

/** A scripted stand-in for a helper process. It talks to Hydra only through the real endpoint, with its own token. */
type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; endTurn: () => void; nextMessage: () => Promise<string>; exit: (code: number) => void; limit: (hit: HeadLimit | undefined) => void; commit: (file: string, text: string) => Promise<void> }) => Promise<void>;

async function fixture(options: { script: Script; checks?: unknown; gates?: unknown; gateRuntime?: HelperServiceOptions['gateRuntime']; lanes?: (root: string, repo: string) => HelperServiceOptions['lanes']; now?: () => number; maxConcurrent?: number }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-helpers-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (options.checks) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'checks.json'), JSON.stringify(options.checks)); }
  if (options.gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(options.gates)); }
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
    gateRuntime: options.gateRuntime, lanes: options.lanes?.(root, repo),
    startRun: spec => {
      runs.push(spec);
      const listeners: (() => void)[] = [], inbox: string[] = [], readers: ((message: string) => void)[] = [];
      let exit!: (code: number) => void; let stopped = false; let limit: HeadLimit | undefined;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = {
        onTurnEnd: listener => { listeners.push(listener); }, exited,
        send: async message => { if (stopped) return false; const reader = readers.shift(); if (reader) reader(message); else inbox.push(message); return true; },
        stop: async () => exit(137),
        limitHit: () => limit,
      };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      // A real helper takes seconds to start; the fake one starts on the next tick.
      setTimeout(() => void options.script({
        spec, exit, limit: hit => { limit = hit; },
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
    assert.equal(first.result.accepted, false); assert.match(first.result.message, /These gates failed:\n- unit \(command, exit 1\)/); assert.equal(first.result.attempts_left, 2);
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
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /Gates failed 3 times/);
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

test('a head that hits a usage limit fails at once with the reason, uses no nudge, and is reported', async () => {
  let nudged = false;
  const f = await fixture({ script: async helper => {
    void helper.nextMessage().then(() => { nudged = true; });
    helper.limit({ message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString() });
    helper.endTurn();
  } });
  const events: LimitEvent[] = [];
  f.service.onLimit(event => events.push(event));
  try {
    const { job_id } = await f.start('limited');
    const [helper] = (await f.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /^Claude usage limit reached \(resets 2026-/);
    assert.equal(nudged, false, 'no nudge was spent on it');
    assert.equal(f.store.get(job_id)!.attempts, 0);
    assert.equal(events.length, 1);
    assert.deepEqual({ ...events[0], at: undefined }, { provider: 'claude', source: 'head', at: undefined, jobId: job_id, message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString(), cwd: f.store.get(job_id)!.worktree });
  } finally { await f.close(); }
  // A Codex exec that fails on its limit exits non-zero instead of ending a turn.
  const exits = await fixture({ script: async helper => { helper.limit({ message: "You've hit your usage limit." }); helper.exit(1); } });
  const codexEvents: LimitEvent[] = [];
  exits.service.onLimit(event => codexEvents.push(event));
  try {
    const { job_id } = await exits.start('limited-exit', { provider: 'codex' });
    const [helper] = (await exits.wait([job_id])).heads;
    assert.equal(helper.state, 'failed'); assert.match(helper.reason, /^Codex usage limit reached: You've hit your usage limit\.$/);
    assert.equal(codexEvents[0]?.provider, 'codex');
  } finally { await exits.close(); }
});

test('continueWith restarts a head that hit a usage limit with the other provider, in the same worktree and branch', async () => {
  const f = await fixture({ checks: passCheck, script: async helper => {
    if (helper.spec.provider === 'claude') {
      helper.limit({ message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString() });
      helper.endTurn();
    } else {
      await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
      const reported = await helper.call('hydra_done', { summary: 'Continued in Codex' });
      assert.equal(reported.result.accepted, true);
      helper.endTurn();
    }
  } });
  try {
    const { job_id } = await f.start('limited-continue');
    const failed = (await f.wait([job_id])).heads[0];
    assert.equal(failed.state, 'failed');
    const before = f.store.get(job_id)!;
    assert.equal(before.limitHit, true);
    assert.ok(before.worktree && before.branch);

    const updated = await f.service.continueWith(job_id, 'codex', '## Handoff\n\nPick up where Claude left off.');
    assert.equal(updated.state, 'queued');
    assert.equal(updated.provider, 'codex');
    assert.equal(updated.attempts, 0);
    assert.equal(updated.nudged, false);
    assert.equal(updated.limitHit, false);
    assert.match(updated.brief, /## Handoff\n\nPick up where Claude left off\./);
    assert.equal(updated.history.at(-1)!.reason, "Continued in Codex after Claude's usage limit.");

    const done = (await f.wait([job_id])).heads[0];
    assert.equal(done.state, 'done');
    const after = f.store.get(job_id)!;
    assert.equal(after.worktree, before.worktree, 'same worktree reused');
    assert.equal(after.branch, before.branch, 'same branch reused');
    assert.equal(f.runs.length, 2, 'one run per provider; no extra worktree created for the continuation');
    assert.equal(f.runs[1]!.provider, 'codex');
    assert.equal(f.runs[1]!.worktree, before.worktree);

    await assert.rejects(f.service.continueWith(job_id, 'claude', 'x'), /did not fail from a usage limit/);
    await assert.rejects(f.service.continueWith('ffffffffffff', 'codex', 'x'), /No head/);
  } finally { await f.close(); }
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

// ---- Gates (docs/Gates_Plan.md, section 1) ----

/** A stand-in reviewer: each review gets the next scripted reply, in the reviewing CLI's own output format. */
function scriptedReviewer(replies: (Record<string, unknown> | { timedOut: true })[]) {
  const specs: ReviewerSpec[] = [];
  const runReviewer = async (spec: ReviewerSpec) => {
    specs.push(spec);
    const reply = replies.shift() ?? { verdict: 'pass', summary: 'Fine.', findings: [] };
    if ('timedOut' in reply) return { args: spec.args, stdout: '', stderr: '', exitCode: null, error: 'Provider check timed out.', timedOut: true };
    const text = JSON.stringify(reply);
    const stdout = spec.provider === 'claude' ? JSON.stringify({ type: 'result', is_error: false, result: text }) : `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n`;
    return { args: spec.args, stdout, stderr: '', exitCode: 0 };
  };
  return { specs, runReviewer };
}
const fixedExists = { id: 'unit', type: 'command', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('src/fixed.ts') ? 0 : 1)"] };
/** A head's key, from the title the fixture gives it ("Job <key>"). */
function jobKey(prompt: string): string | undefined { return /\): Job (\S+)$/m.exec(prompt)?.[1]; }

test('a head\'s work goes through the gates in order; failures come back with the findings, and attempts are counted', async () => {
  const reviewer = scriptedReviewer([
    { verdict: 'fail', summary: 'The flag is wrong.', findings: [{ file: 'src/fixed.ts', line: 1, severity: 'major', note: 'Always true.' }, { severity: 'minor', note: 'Name it better.' }] },
    { verdict: 'fail', summary: 'Only a nit left.', findings: [{ severity: 'minor', note: 'Name it better.' }] },
  ]);
  const f = await fixture({ gates: { gates: [{ id: 'review', type: 'review', focus: 'The flag.' }, fixedExists] }, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    await helper.commit('src/wip.ts', 'wip\n');
    const first = await helper.call('hydra_done', { summary: 'First try' });
    assert.equal(first.result.accepted, false); assert.equal(first.result.attempts_left, 2);
    assert.match(first.result.message, /^These gates failed:\n- unit \(command, exit 1\): Exited with code 1\./);
    assert.doesNotMatch(first.result.message, /review/, 'the review is skipped while the tests fail');
    await helper.commit('src/fixed.ts', 'export const fixed = true;\n');
    const second = await helper.call('hydra_done', { summary: 'Second try' });
    assert.equal(second.result.accepted, false); assert.equal(second.result.attempts_left, 1);
    assert.match(second.result.message, /^These gates failed:\n- review \(review by Codex\): Reviewed by Codex\. The flag is wrong\.\n  - major src\/fixed\.ts:1: Always true\.\n  - minor: Name it better\.\nFix them, commit, and call hydra_done again\.$/);
    await helper.commit('src/fixed.ts', 'export const fixed = process.env.FLAG === "1";\n');
    const third = await helper.call('hydra_done', { summary: 'Fixed the flag' });
    assert.equal(third.result.accepted, true, 'a fail with only minor findings passes');
    helper.endTurn();
  } });
  try {
    const { job_id } = await f.start('gated');
    const [head] = (await f.wait([job_id])).heads;
    assert.equal(head.state, 'done'); assert.equal(head.attempts, 3); assert.equal(head.max_attempts, 3);
    assert.deepEqual(head.checks.map((check: { id: string; kind: string; state: string }) => [check.id, check.kind, check.state]), [['unit', 'command', 'passed'], ['review', 'review', 'passed']]);
    assert.equal(head.checks[1].summary, 'Reviewed by Codex. Only a nit left.');
    assert.deepEqual(head.checks[1].findings, [{ severity: 'minor', note: 'Name it better.' }]);
    assert.ok(head.checks[1].evidence.length >= 1 && head.checks[0].evidence.length === 1);
    // hydra_get_head returns the same gate results.
    assert.deepEqual((await f.call('hydra_get_head', { job_id })).result.checks, head.checks);
    // The other agent reviewed a Claude head, read-only, in the head's worktree, with the brief and scope.
    assert.equal(reviewer.specs.length, 2);
    const [spec] = reviewer.specs;
    assert.equal(spec!.provider, 'codex'); assert.equal(spec!.cwd, f.store.get(job_id)!.worktree);
    assert.deepEqual(spec!.args, ['exec', '--json', '--sandbox', 'read-only', '-']);
    assert.match(spec!.input, /## The task\nJob gated\n\nDo the thing\.\n\nIt may change only: src\//);
    assert.match(spec!.input, /- unit \(command\): passed/); assert.match(spec!.input, /## What to focus on\nThe flag\./);
    assert.match(spec!.input, /\+export const fixed = true;/);
  } finally { await f.close(); }
});

test('maxAttempts comes from gates.json; a review that can\'t run never fails the head; a broken gates file costs no attempt', async () => {
  const reviewer = scriptedReviewer([{ timedOut: true }]);
  const f = await fixture({ gates: { maxAttempts: 1, gates: [fixedExists, { id: 'review', type: 'review' }] }, gateRuntime: { runReviewer: reviewer.runReviewer }, script: async helper => {
    if (jobKey(helper.spec.prompt) === 'once') {
      await helper.commit('src/wip.ts', 'wip\n');
      const only = await helper.call('hydra_done', { summary: 'Only try' });
      assert.match(only.result.message, /last attempt \(1 of 1\)/);
    } else {
      await helper.commit('src/fixed.ts', 'fixed\n');
      assert.equal((await helper.call('hydra_done', { summary: 'Reviewer timed out' })).result.accepted, true);
      helper.endTurn();
    }
  } });
  try {
    const once = await f.start('once');
    const failed = (await f.wait([once.job_id])).heads[0];
    assert.equal(failed.state, 'failed'); assert.equal(failed.reason, 'Gates failed 1 time.'); assert.equal(failed.max_attempts, 1);
    assert.deepEqual(failed.checks.map((check: { id: string; state: string }) => [check.id, check.state]), [['unit', 'failed'], ['review', 'notRun']]);
    const notRun = await f.start('not-run');
    const accepted = (await f.wait([notRun.job_id])).heads[0];
    assert.equal(accepted.state, 'done');
    const review = accepted.checks.find((check: { id: string }) => check.id === 'review');
    assert.deepEqual({ state: review.state, passed: review.passed, required: review.required }, { state: 'notRun', passed: false, required: true });
    assert.equal(review.summary, 'Codex didn\'t finish its review in 5 minutes.');
  } finally { await f.close(); }

  const broken = await fixture({ gates: { gates: 'unit' }, script: async helper => {
    await helper.commit('src/fixed.ts', 'fixed\n');
    const refused = await helper.call('hydra_done', { summary: 'Done' });
    assert.equal(refused.result.accepted, false);
    assert.match(refused.result.message, /^Hydra can't check your work: \.hydra\/gates\.json: The gates file needs a "gates" list\. That isn't your fault\. Call hydra_stuck/);
    await helper.call('hydra_progress', { note: 'waiting on the lead' });
  } });
  try {
    const { job_id } = await broken.start('broken');
    await until(() => broken.store.get(job_id)?.progress === 'waiting on the lead', 'the head was told');
    assert.equal(broken.store.get(job_id)!.state, 'running'); assert.equal(broken.store.get(job_id)!.attempts, 0);
  } finally { await broken.close(); }
});

// ---- What a head starts from (docs/Gates_Plan.md, section 3) ----

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

test('a dependent starts from its dependency\'s result commit, sees its file, and is told what it did', async () => {
  const f = await fixture({ script: async helper => {
    if (jobKey(helper.spec.prompt) === 'first') {
      await helper.commit('src/first.ts', 'export const first = 1;\n');
      await helper.call('hydra_done', { summary: 'Added first.ts with the parser.' });
    } else {
      assert.match(await readFile(path.join(helper.spec.worktree, 'src', 'first.ts'), 'utf8'), /^export const first = 1;\r?\n$/);
      await helper.commit('src/second.ts', 'export const second = 2;\n');
      await helper.call('hydra_done', { summary: 'Added second.ts on top.' });
    }
    helper.endTurn();
  } });
  try {
    const first = await f.start('first');
    const second = await f.start('second', { depends_on: [first.job_id] });
    assert.equal(second.base_commit, undefined, 'its base is known only once it starts');
    assert.match(second.starts_from, /heads it depends on/);
    const [one, two] = (await f.wait([first.job_id, second.job_id])).heads;
    assert.equal(one.state, 'done'); assert.equal(two.state, 'done', two.reason);
    assert.equal(two.base_commit, one.commit, 'base_commit is where it really started');
    assert.deepEqual(two.changed_files, ['src/second.ts'], 'its own changes only');
    const prompt = f.runs.find(run => jobKey(run.prompt) === 'second')!.prompt;
    assert.match(prompt, new RegExp(`What the heads you depend on did \\(your worktree already has their work\\):\\n- Job first \\(branch ${escape(one.branch)}, commit ${one.commit.slice(0, 12)}\\): Added first\\.ts with the parser\\.\\n  Changed files: src/first\\.ts`));
    assert.match(prompt, new RegExp(`It starts from commit ${one.commit}, which already has the work of the heads it depends on\\.`));
    assert.doesNotMatch(f.runs.find(run => jobKey(run.prompt) === 'first')!.prompt, /What the heads you depend on did/);
  } finally { await f.close(); }
});

test('several dependencies are merged into one Hydra commit; ones that conflict fail the dependent before it starts, naming the files', async () => {
  const f = await fixture({ maxConcurrent: 3, script: async helper => {
    const key = jobKey(helper.spec.prompt)!;
    if (key === 'clashing') assert.fail('a dependent whose dependencies conflict never starts');
    if (key === 'both') {
      for (const file of ['one.ts', 'two.ts']) assert.ok((await readFile(path.join(helper.spec.worktree, 'src', file), 'utf8')).length > 0, file);
      await helper.commit('src/both.ts', 'both\n');
    } else if (key.startsWith('clash-')) await helper.commit('src/shared.ts', `${key}\n`);
    else await helper.commit(`src/${key}.ts`, `${key}\n`);
    await helper.call('hydra_done', { summary: `Did ${key}.` });
    helper.endTurn();
  } });
  try {
    const one = await f.start('one'), two = await f.start('two');
    const both = await f.start('both', { depends_on: [one.job_id, two.job_id] });
    const clashA = await f.start('clash-a'), clashB = await f.start('clash-b');
    const clashing = await f.start('clashing', { depends_on: [clashA.job_id, clashB.job_id] });
    const [a, b, merged, refused] = (await f.wait([one.job_id, two.job_id, both.job_id, clashing.job_id])).heads;
    assert.equal(merged.state, 'done', merged.reason);
    const [base, ...parents] = (await git(f.repo, ['rev-list', '--parents', '-n', '1', merged.base_commit])).trim().split(' ');
    assert.equal(base, merged.base_commit);
    assert.deepEqual(parents, [a.commit, b.commit], 'one commit, whose parents are both dependencies');
    assert.match(await git(f.repo, ['log', '-1', '--format=%an%n%s', merged.base_commit]), /^Hydra\nHydra: merge the heads "Job both" depends on/);
    assert.deepEqual(merged.changed_files, ['src/both.ts']);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.reason, 'Could not start: The heads it depends on conflict in src/shared.ts; merge them first.');
    assert.equal(f.store.get(clashing.job_id)!.worktree, undefined, 'no worktree was made for it');
    assert.equal(f.runs.some(run => jobKey(run.prompt) === 'clashing'), false);
  } finally { await f.close(); }
});

test('a head started from a lane takes the lane\'s HEAD as its base, not the main checkout\'s', async () => {
  const laneId = 'abcabcabcabc';
  const f = await fixture({
    lanes: root => ({ describe: async () => ({}), name: id => id === laneId ? 'Lane one' : undefined, worktree: id => id === laneId ? path.join(root, 'lane') : undefined }),
    script: async helper => {
      if (jobKey(helper.spec.prompt) === 'from-lane') assert.match(await readFile(path.join(helper.spec.worktree, 'src', 'lane.ts'), 'utf8'), /^lane work\r?\n$/, 'the lane\'s committed work is there');
      await helper.commit('src/head.ts', 'head\n');
      await helper.call('hydra_done', { summary: 'Done.' });
      helper.endTurn();
    },
  });
  try {
    const lane = path.join(f.root, 'lane');
    await git(f.repo, ['worktree', 'add', '-q', '-b', `lane/one-${laneId}`, lane, 'HEAD']);
    await writeFile(path.join(lane, 'src', 'lane.ts'), 'lane work\n');
    await git(lane, ['add', '.']); await git(lane, ['commit', '-qm', 'lane work']);
    await writeFile(path.join(lane, 'src', 'lane.ts'), 'uncommitted lane work\n');
    const laneHead = (await git(lane, ['rev-parse', 'HEAD'])).trim(), mainHead = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    const token = f.endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345', provider: 'claude', lane: laneId });
    const started = (await callHelperEndpoint(f.endpoint.port, token, 'hydra_start_head', { title: 'Job from-lane', brief: 'Build on the lane.', write_scope: ['src/'], idempotency_key: 'from-lane' })).result as { job_id: string; base_commit: string; warning?: string };
    assert.equal(started.base_commit, laneHead);
    assert.match(started.warning!, /^Your lane has uncommitted changes\. The head starts from the lane's last commit/);
    const plain = await f.start('plain');
    assert.equal(plain.base_commit, mainHead, 'the window\'s own lead still branches from the main checkout');
    const [fromLane] = (await f.wait([started.job_id, plain.job_id])).heads;
    assert.equal(fromLane.state, 'done', fromLane.reason); assert.equal(fromLane.base_commit, laneHead);
    assert.equal(f.store.get(started.job_id)!.lead?.lane, laneId);
    assert.deepEqual(fromLane.changed_files, ['src/head.ts']);
  } finally { await f.close(); }
});

test('the dependency summaries for a dependent\'s brief are capped at 4 KB', () => {
  const brief = dependencyBrief([
    { id: 'a'.repeat(12), title: 'Parser', summary: 'Added the parser.', commit: 'c'.repeat(40), branch: 'agent/parser-aaaaaaaaaaaa', changedFiles: ['src/parser.ts', 'tests/parser.test.ts'] },
    { id: 'b'.repeat(12), title: 'Huge', summary: 'x'.repeat(10_000), commit: 'd'.repeat(40), changedFiles: Array.from({ length: 30 }, (_, index) => `src/f${index}.ts`) },
  ]);
  assert.ok(brief.length <= maxDependencyBrief, String(brief.length));
  assert.match(brief, /^What the heads you depend on did \(your worktree already has their work\):\n- Parser \(branch agent\/parser-aaaaaaaaaaaa, commit cccccccccccc\): Added the parser\.\n  Changed files: src\/parser\.ts, tests\/parser\.test\.ts\n- Huge \(commit dddddddddddd\): x+…$/);
});
