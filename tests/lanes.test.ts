import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LaneStore, canLaneTransition, isLaneBranch, isSafeBranchName, laneBranch, laneContinuePrompt, laneSlug, laneStates, laneTransitions, lanePreamble, lanePreambleMax, parseLaneInput, restartedLanes, validateLane, type Lane } from '../src/core/lanes';
import { LaneTerminal, loadNodePty, ptyCandidates } from '../src/core/lanePty';
import { FakePty } from './lanePtyFake';
import { laneLaunch, parseTestCommand, shimSafe } from '../src/core/laneService';
import { parseMessage } from '../src/core/model';
import { processLaunch } from '../src/core/process';
import { HelperEndpoint, requestLeadSession, type HelperCaller } from '../src/core/helperEndpoint';
import { findWindowFor, writeWindowRecord } from '../src/core/helperDiscovery';
import { createBridge, laneFromEnv } from '../src/core/mcpBridge';
import { laneGuidance, leadGuidanceMarkdown, leadTools, toolAllowed } from '../src/core/helperTools';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const id = 'abcdef012345';
const sample = (extra: Partial<Lane> = {}): Lane => ({
  id, name: 'Checkout fix', provider: 'claude', goal: 'Fix the checkout', repository: path.resolve('/repo'), worktree: path.resolve('/repo.worktrees', `lane-${id}`),
  branch: `lane/checkout-fix-${id}`, baseCommit: 'a'.repeat(40), target: 'main', createdAt: '2026-09-24T10:00:00.000Z', state: 'running', ...extra,
});

test('lane input and stored records are validated field by field', () => {
  assert.deepEqual(parseLaneInput({ name: '  Checkout   fix ', provider: 'codex', goal: '  Fix it  ' }), { name: 'Checkout fix', provider: 'codex', goal: 'Fix it' });
  assert.equal(parseLaneInput({ name: 'Lane\n1', provider: 'claude' }).name, 'Lane 1', 'whitespace is collapsed');
  assert.deepEqual(parseLaneInput({ name: 'Lane 1', provider: 'claude', goal: '   ' }), { name: 'Lane 1', provider: 'claude' }, 'an empty goal starts the CLI without a prompt');
  assert.deepEqual(parseLaneInput({ name: 'Überprüfung (2)', provider: 'claude' }).name, 'Überprüfung (2)');
  for (const name of ['', '   ', 'x'.repeat(41), 'a & b', 'it\'s', 'say "hi"', '100%', 'a|b', 'a<b', 'a\u0007b', 'a^b']) assert.throws(() => parseLaneInput({ name, provider: 'claude' }), /name/i, JSON.stringify(name));
  assert.throws(() => parseLaneInput({ name: 'x', provider: 'gpt' }), /Claude Code or Codex/);
  assert.throws(() => parseLaneInput({ name: 'x', provider: 'claude', goal: 'g'.repeat(2001) }), /2000/);
  assert.throws(() => parseLaneInput({ name: 'x', provider: 'claude', goal: 'a\0b' }), /text/);
  assert.equal(laneSlug('Checkout: Fix — Ünïcode!!'), 'checkout-fix-unicode');
  assert.equal(laneSlug('!!!'), 'lane');
  assert.equal(laneSlug('x'.repeat(31) + ' y'), 'x'.repeat(31), 'a cut never leaves a trailing dash');
  assert.equal(laneBranch('Checkout fix', id), `lane/checkout-fix-${id}`);
  assert.ok(isLaneBranch(laneBranch('Überprüfung (2)', id), id));
  for (const branch of [`agent/x-${id}`, `lane/x-${'b'.repeat(12)}`, `lane/-x-${id}`, `lane/x--y-${id}`, `lane/X-${id}`, `lane/x;rm-${id}`]) assert.equal(isLaneBranch(branch, id), false, branch);
  for (const target of ['main', 'release/1.2', 'feat/a_b-c', 'v1.0+hotfix']) assert.ok(isSafeBranchName(target), target);
  for (const target of ['-main', '--upload-pack=x', 'a..b', 'a@{1}', '@', '.hidden', 'a/.b', 'x.lock', 'a b', 'a~1', 'a^', 'a:b', '', 'a/', 'end.']) assert.equal(isSafeBranchName(target), false, target);
  assert.deepEqual(validateLane(sample()), sample());
  assert.throws(() => validateLane(sample({ id: 'ABC' })), /invalid id/);
  assert.throws(() => validateLane(sample({ branch: 'main' })), /invalid branch/);
  assert.throws(() => validateLane(sample({ worktree: path.resolve('/elsewhere') })), /didn't make/);
  assert.throws(() => validateLane(sample({ target: '--force' })), /target branch/);
  assert.throws(() => validateLane(sample({ baseCommit: 'HEAD' })), /base commit/);
  assert.throws(() => validateLane(sample({ state: 'paused' as never })), /malformed/);
  assert.throws(() => validateLane(sample({ repository: 'relative' })), /invalid path/);
  // Provider switches (docs/Gates_Plan.md, section 2).
  const switches = [{ from: 'claude' as const, to: 'codex' as const, at: '2026-09-25T10:00:00.000Z', reason: 'limit' as const }];
  assert.deepEqual(validateLane(sample({ switches })).switches, switches);
  assert.equal(validateLane(sample({ switches: undefined })).switches, undefined);
  for (const bad of [[{ from: 'claude', to: 'claude', at: '2026-09-25T10:00:00.000Z', reason: 'limit' }], [{ from: 'gpt', to: 'codex', at: '2026-09-25T10:00:00.000Z', reason: 'limit' }], [{ from: 'claude', to: 'codex', at: 'not a date', reason: 'limit' }], [{ from: 'claude', to: 'codex', at: '2026-09-25T10:00:00.000Z', reason: 'because' }], 'nope']) {
    assert.throws(() => validateLane(sample({ switches: bad as never })), /switch/, JSON.stringify(bad));
  }
  assert.equal(validateLane(sample({ switches: Array.from({ length: 80 }, () => switches[0]!) })).switches!.length, 50, 'only the newest 50 are kept');
});

test('laneContinuePrompt is one line, names the provider that hit its limit, and carries the flattened handoff', () => {
  const lane = { name: 'Lane 1', branch: `lane/lane-1-${id}`, goal: 'Fix the checkout' };
  const text = laneContinuePrompt(lane, 'claude', [], 'Continue this task in /repo.\n\n## What\'s left\n\n- Ship it');
  assert.doesNotMatch(text, /[\r\n]/);
  assert.match(text, /^You are working in Hydra lane "Lane 1" on branch lane\/lane-1-[a-f0-9]{12}\./);
  assert.match(text, /You are continuing in this lane after Claude Code hit its usage limit\./);
  assert.match(text, /Handoff: Continue this task in \/repo\. ## What's left - Ship it$/);
  const long = laneContinuePrompt(lane, 'codex', [], 'x'.repeat(10_000));
  assert.ok(long.length <= lanePreambleMax * 2, `${long.length}`);
  assert.doesNotMatch(long, /[\r\n]/);
  assert.match(long, /Codex hit its usage limit/);
});

test('lane states change only along the table, and a restart turns running lanes into exited ones', async () => {
  for (const from of laneStates) for (const to of laneStates) assert.equal(canLaneTransition(from, to), from === to || laneTransitions[from].includes(to), `${from} -> ${to}`);
  assert.deepEqual(laneTransitions.closed, []);
  const { lanes, changed } = restartedLanes([sample(), sample({ id: 'bbbbbbbbbbbb', worktree: path.resolve('/repo.worktrees/lane-bbbbbbbbbbbb'), branch: 'lane/b-bbbbbbbbbbbb', state: 'merged' })]);
  assert.equal(changed, true);
  assert.deepEqual(lanes.map(lane => [lane.state, lane.reason]), [['exited', 'Hydra restarted'], ['merged', undefined]]);
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-lanes-store-'));
  try {
    const store = new LaneStore(directory);
    await store.load();
    await store.add(sample());
    await assert.rejects(store.add(sample()), /already exists/);
    await store.update(id, { state: 'exited', exitCode: 0 });
    await assert.rejects(store.update(id, { state: 'closed' }).then(() => store.update(id, { state: 'running' })), /is closed/);
    await store.remove(id);
    await store.add(sample());
    // Another start of the extension host: the running lane comes back exited, its record otherwise intact.
    const logged: string[] = [];
    await writeFile(path.join(directory, 'lanes.json'), JSON.stringify({ version: 1, lanes: [sample(), { ...sample(), id: 'not-a-lane' }] }));
    const restarted = new LaneStore(directory, line => logged.push(line));
    const loaded = await restarted.load();
    assert.deepEqual(loaded.map(lane => [lane.id, lane.state, lane.reason]), [[id, 'exited', 'Hydra restarted']]);
    assert.match(logged.join('\n'), /skipped: A stored lane has an invalid id/, 'a malformed lane is skipped, not guessed at');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'lanes.json'), 'utf8')).lanes[0].state, 'exited', 'the transition is written back');
    assert.deepEqual(restarted.open().map(lane => lane.id), [id]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exitedAt is set when a lane becomes exited, and cleared on resume/restart (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up")', async () => {
  const restarted = restartedLanes([sample()], Date.parse('2026-09-25T10:00:00.000Z'));
  assert.equal(restarted.lanes[0]!.exitedAt, '2026-09-25T10:00:00.000Z');
  assert.throws(() => validateLane(sample({ exitedAt: 'not a date' })), /invalid exited time/);
  assert.equal(validateLane(sample({ exitedAt: '2026-09-25T10:00:00.000Z' })).exitedAt, '2026-09-25T10:00:00.000Z');
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-lanes-exitedat-'));
  try {
    const store = new LaneStore(directory);
    await store.load();
    await store.add(sample());
    const exited = await store.update(id, { state: 'exited', exitCode: 1, exitedAt: '2026-09-25T10:05:00.000Z' });
    assert.equal(exited.exitedAt, '2026-09-25T10:05:00.000Z');
    const resumed = await store.update(id, { state: 'running', exitCode: undefined, exitedAt: undefined });
    assert.equal(resumed.exitedAt, undefined, 'resuming clears exitedAt');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the first prompt is one line, lists the other lanes, and is capped', () => {
  const others = [
    { name: 'Lane 2', provider: 'codex' as const, goal: 'Rework the cart\nand its tests', files: ['src/cart.ts', 'src/cart.test.ts'] },
    { name: 'Lane 3', provider: 'claude' as const, files: [] },
  ];
  const text = lanePreamble({ name: 'Lane 1', branch: `lane/lane-1-${id}`, goal: 'Fix the checkout\r\nthen the docs' }, others);
  assert.doesNotMatch(text, /[\r\n]/);
  assert.equal(text, `You are working in Hydra lane "Lane 1" on branch lane/lane-1-${id}. Other lanes in progress: Lane 2 (Codex): Rework the cart and its tests, files src/cart.ts, src/cart.test.ts; Lane 3 (Claude Code): no goal given, no files changed yet. Call hydra_lanes to check again before large changes, and avoid editing files other lanes are changing. Your task: Fix the checkout then the docs`);
  assert.match(lanePreamble({ name: 'Solo', branch: 'lane/solo-x', goal: 'Go' }, []), /No other lanes are in progress\. .* Your task: Go$/);
  const crowded = Array.from({ length: 20 }, (_, index) => ({ name: `Lane ${index}`, provider: 'codex' as const, goal: 'g'.repeat(500), files: Array.from({ length: 50 }, (_, file) => `src/${'deep/'.repeat(30)}file-${file}.ts`) }));
  const long = lanePreamble({ name: 'Lane 1', branch: 'lane/lane-1-x', goal: 'task '.repeat(400) }, crowded);
  assert.ok(long.length <= lanePreambleMax, `${long.length}`);
  assert.doesNotMatch(long, /[\r\n]/);
  assert.match(long, /Your task: task task/, 'the task survives the cap');
  assert.match(long, /Lane 0 \(Codex\): g{79}…, files .*and 45 more/, 'goals are clipped to 80 and files to five');
});

test('node-pty is loaded from the host, trying each place in order', () => {
  const root = path.resolve('/app');
  assert.deepEqual(ptyCandidates(root), [path.join(root, 'node_modules', 'node-pty'), path.join(root, 'node_modules.asar.unpacked', 'node-pty'), path.join(root, 'node_modules.asar', 'node-pty')]);
  const pty = { spawn: () => { throw new Error('unused'); } };
  const tried: string[] = [];
  const found = loadNodePty(root, candidate => { tried.push(candidate); if (candidate.includes('node_modules.asar' + path.sep)) return pty; if (candidate.includes('unpacked')) return {}; throw new Error(`Cannot find module '${candidate}'\nRequire stack: x`); });
  assert.equal(found.module, pty);
  assert.deepEqual(tried, ptyCandidates(root));
  assert.equal(found.errors.length, 2); assert.match(found.errors[1]!, /no spawn function/); assert.doesNotMatch(found.errors[0]!, /Require stack/);
  const missing = loadNodePty(root, () => { throw new Error('Cannot find module'); });
  assert.equal(missing.module, undefined, 'no module: terminals are unavailable and nothing else breaks');
  assert.equal(missing.errors.length, 3);
  assert.equal(loadNodePty(undefined).module, undefined);
});

test('a lane terminal batches output, keeps a capped replay, resizes, and reports its exit', async () => {
  const pty = new FakePty(77);
  const data: string[] = [], exits: number[] = [], killed: number[] = [];
  const terminal = new LaneTerminal(pty, { onData: chunk => data.push(chunk), onExit: code => exits.push(code), replayLimit: 2048, initialReplay: 'earlier session\r\n', killTree: async pid => { killed.push(pid); } });
  pty.emit('a'); pty.emit('b'); pty.emit('c');
  assert.deepEqual(data, [], 'output waits for the 16 ms batch');
  await delay(40);
  assert.deepEqual(data, ['abc'], 'one batch');
  assert.equal(terminal.replay(), 'earlier session\r\nabc');
  pty.emit('pending');
  assert.equal(terminal.replay(), 'earlier session\r\nabcpending', 'a replay includes output not yet flushed');
  for (let line = 0; line < 100; line++) pty.emit(`line ${String(line).padStart(3, '0')} ${'x'.repeat(40)}\r\n`);
  await delay(40);
  const replay = terminal.replay();
  assert.ok(replay.length <= 2048, `${replay.length}`);
  assert.ok(replay.endsWith(`line 099 ${'x'.repeat(40)}\r\n`), 'the newest output is kept');
  assert.match(replay, /^line \d{3} /, 'the oldest output is dropped at a line break');
  terminal.resize(120, 40);
  assert.deepEqual(pty.sizes, [[120, 40]]);
  for (const [cols, rows] of [[19, 30], [501, 30], [100, 4], [100, 201], [100.5, 30]]) assert.throws(() => terminal.resize(cols!, rows!), /Invalid terminal size/);
  terminal.write('ls\r');
  assert.deepEqual(pty.written, ['ls\r']);
  pty.emit('bye');
  pty.exit(3);
  assert.equal(await terminal.exited, 3);
  assert.deepEqual(exits, [3]); assert.equal(terminal.running, false); assert.equal(terminal.exitCode, 3);
  assert.equal(data.at(-1), 'bye', 'output before the exit is flushed first');
  terminal.write('ignored'); terminal.resize(80, 24);
  assert.deepEqual(pty.written, ['ls\r']); assert.equal(pty.sizes.length, 1);
  await terminal.kill();
  assert.equal(killed.length, 0, 'an exited terminal is not killed again');

  const running = new FakePty(88);
  const second = new LaneTerminal(running, { killTree: async pid => { killed.push(pid); } });
  await second.kill();
  assert.deepEqual(killed, [88], 'the process tree is killed first');
  assert.equal(running.killed, true, 'then the pty itself');
  assert.equal(second.running, false);
});

test('parseMessage validates every lane message', () => {
  assert.deepEqual(parseMessage({ type: 'laneNew', name: ' Lane 1 ', provider: 'codex', goal: 'Fix it' }), { type: 'laneNew', name: 'Lane 1', provider: 'codex', goal: 'Fix it' });
  assert.deepEqual(parseMessage({ type: 'laneNew', name: 'Lane 1', provider: 'claude', goal: '  ' }), { type: 'laneNew', name: 'Lane 1', provider: 'claude' });
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { name: 'a\u0007b' }, { name: 3 }, { provider: 'gpt' }, { goal: 'g'.repeat(2001) }, { goal: 7 }]) assert.throws(() => parseMessage({ type: 'laneNew', name: 'Lane', provider: 'claude', ...bad }), JSON.stringify(bad));
  assert.deepEqual(parseMessage({ type: 'laneAttach' }), { type: 'laneAttach' });
  assert.deepEqual(parseMessage({ type: 'laneInput', id, data: '\u0003\r' }), { type: 'laneInput', id, data: '\u0003\r' });
  assert.deepEqual(parseMessage({ type: 'laneInput', id, data: 'x'.repeat(64 * 1024) }).type, 'laneInput');
  assert.throws(() => parseMessage({ type: 'laneInput', id, data: 'x'.repeat(64 * 1024 + 1) }), /lane input/);
  assert.throws(() => parseMessage({ type: 'laneInput', id, data: 'é'.repeat(40 * 1024) }), /lane input/, 'the cap is in UTF-8 bytes');
  assert.throws(() => parseMessage({ type: 'laneInput', id: 'ABCDEF012345', data: 'x' }), /lane ID/);
  assert.throws(() => parseMessage({ type: 'laneInput', id: '../../etc', data: 'x' }), /lane ID/);
  assert.deepEqual(parseMessage({ type: 'laneResize', id, cols: 20, rows: 200 }), { type: 'laneResize', id, cols: 20, rows: 200 });
  for (const [cols, rows] of [[19, 30], [501, 30], [80, 4], [80, 201], [80.5, 30], ['80', 30]]) assert.throws(() => parseMessage({ type: 'laneResize', id, cols, rows }), /Invalid (cols|rows)/);
  for (const action of ['commit', 'merge', 'update', 'pr', 'close', 'resume', 'restart', 'diff', 'openWindow', 'refresh', 'switchProvider']) assert.deepEqual(parseMessage({ type: 'laneAction', id, action }), { type: 'laneAction', id, action });
  assert.throws(() => parseMessage({ type: 'laneAction', id, action: 'push --force' }), /Unknown lane action/);
  assert.throws(() => parseMessage({ type: 'laneAction', id: 'x', action: 'merge' }), /lane ID/);
  // The usage-limit banner (docs/Gates_Plan.md, section 2).
  for (const action of ['continueOther', 'viewHandoff', 'wait']) assert.deepEqual(parseMessage({ type: 'laneLimitAction', id, action }), { type: 'laneLimitAction', id, action });
  assert.throws(() => parseMessage({ type: 'laneLimitAction', id, action: 'setupOther' }), /Unknown lane limit action/);
  assert.throws(() => parseMessage({ type: 'laneLimitAction', id: 'x', action: 'wait' }), /lane ID/);
  assert.deepEqual(parseMessage({ type: 'laneCancelSwitch', id }), { type: 'laneCancelSwitch', id });
  assert.throws(() => parseMessage({ type: 'laneCancelSwitch', id: 'nope' }), /lane ID/);
  assert.deepEqual(parseMessage({ type: 'view', view: 'lanes', focus: id }), { type: 'view', view: 'lanes', focus: id });
  assert.deepEqual(parseMessage({ type: 'view', view: 'canvas' }), { type: 'view', view: 'canvas' });
  assert.throws(() => parseMessage({ type: 'view', view: 'plans' }), /Unknown view/);
  assert.throws(() => parseMessage({ type: 'view', view: 'lanes', focus: 'nope' }), /lane or head ID/);
  assert.deepEqual(parseMessage({ type: 'ready' }), { type: 'ready' }, 'the existing messages still parse');
});

test('a lane launches its CLI with the plan\'s arguments and environment', () => {
  const lane = { id, name: 'Lane 1', branch: `lane/lane-1-${id}`, provider: 'claude' as const };
  const bridge = { command: 'C:\\Program Files\\Hydra\\Hydra.exe', args: ['C:\\Program Files\\Hydra\\hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: 'C:\\h', HYDRA_LEAD_PROVIDER: 'claude' } };
  const base = { lane, executable: 'C:\\bin\\claude.exe', resume: false, connected: false, bridge, mcpConfigFile: 'C:\\s\\lane.mcp.json', helpersDir: 'C:\\h', env: { PATH: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', HOME: 'C:\\u', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'parent' }, platform: 'win32' as const };
  const fresh = laneLaunch({ ...base, prompt: 'You are working in Hydra lane "Lane 1". Your task: fix 100% & ship' });
  assert.deepEqual(fresh.args, ['--mcp-config', 'C:\\s\\lane.mcp.json', 'You are working in Hydra lane "Lane 1". Your task: fix 100% & ship'], 'a real executable gets the prompt untouched');
  const server = JSON.parse(fresh.mcpConfig!).mcpServers.hydra;
  assert.deepEqual(server, { type: 'stdio', command: bridge.command, args: bridge.args, env: { ...bridge.env, HYDRA_LANE_ID: id, HYDRA_LANE_NAME: 'Lane 1', HYDRA_LANE_BRANCH: lane.branch, HYDRA_LANE_HELPERS_DIR: 'C:\\h' }, timeout: 3_600_000 });
  assert.deepEqual({ ...fresh.env, PATH: undefined }, { PATH: undefined, HOME: 'C:\\u', HYDRA_LANE_ID: id, HYDRA_LANE_NAME: 'Lane 1', HYDRA_LANE_BRANCH: lane.branch, HYDRA_LANE_HELPERS_DIR: 'C:\\h', HYDRA_LEAD_PROVIDER: 'claude', HYDRA_HELPERS_DIR: 'C:\\h', TERM: 'xterm-256color', COLORTERM: 'truecolor', DISABLE_AUTOUPDATER: '1' }, 'a parent Claude session\'s markers never reach the lane, and the CLI never self-updates');
  assert.equal(fresh.env.ELECTRON_RUN_AS_NODE, undefined, 'the host\'s run-as-Node flag never reaches the lane');
  const connected = laneLaunch({ ...base, connected: true });
  assert.deepEqual(connected.args, [], 'a connected Claude already has Hydra; no goal starts it empty');
  assert.equal(connected.mcpConfig, undefined);
  assert.deepEqual(laneLaunch({ ...base, resume: true, prompt: 'ignored' }).args, ['--continue', '--mcp-config', 'C:\\s\\lane.mcp.json']);
  assert.deepEqual(laneLaunch({ ...base, connected: true, resume: true }).args, ['--continue']);

  const codexLane = { ...lane, provider: 'codex' as const };
  const codexConnected = laneLaunch({ ...base, lane: codexLane, executable: 'C:\\bin\\codex.exe', connected: true, prompt: 'Go' });
  assert.deepEqual(codexConnected.args, ['-c', `mcp_servers.hydra.env.HYDRA_LANE_ID='${id}'`, '-c', 'mcp_servers.hydra.env.HYDRA_LANE_NAME=\'Lane 1\'', '-c', `mcp_servers.hydra.env.HYDRA_LANE_BRANCH='${lane.branch}'`, '-c', 'mcp_servers.hydra.env.HYDRA_LANE_HELPERS_DIR=\'C:\\h\'', 'Go'], 'Codex clears its servers\' environment, so the lane is passed in its config');
  assert.equal(codexConnected.env.HYDRA_LEAD_PROVIDER, 'codex');
  const codexAlone = laneLaunch({ ...base, lane: codexLane, executable: 'C:\\bin\\codex.exe', resume: true });
  assert.deepEqual(codexAlone.args.slice(-2), ['resume', '--last']);
  assert.deepEqual(codexAlone.args.slice(0, 4), ['-c', `mcp_servers.hydra.command='${bridge.command}'`, '-c', `mcp_servers.hydra.args=['${bridge.args[0]}']`]);
  assert.ok(codexAlone.args.includes(`mcp_servers.hydra.env={ ELECTRON_RUN_AS_NODE = '1', HYDRA_HELPERS_DIR = 'C:\\h', HYDRA_LEAD_PROVIDER = 'claude', HYDRA_LANE_ID = '${id}', HYDRA_LANE_NAME = 'Lane 1', HYDRA_LANE_BRANCH = '${lane.branch}', HYDRA_LANE_HELPERS_DIR = 'C:\\h' }`));
  assert.ok(codexAlone.args.includes('mcp_servers.hydra.default_tools_approval_mode=\'approve\''));
  assert.equal(codexAlone.mcpConfig, undefined);
  assert.throws(() => laneLaunch({ ...base, lane: codexLane, bridge: { ...bridge, command: 'C:\\it\'s\\Hydra.exe' } }), /quote/);

  // Through a .cmd shim the prompt meets cmd.exe, so it keeps to characters cmd reads literally.
  const shim = laneLaunch({ ...base, executable: 'C:\\npm\\claude.cmd', connected: true, prompt: 'Fix "Buy" at 100% & |pipe| <tag> ^caret !bang\\' });
  assert.deepEqual(shim.args, ['Fix \'Buy\' at 100 pipe tag caret bang']);
  assert.equal(shimSafe('a\r\nb\tc%PATH%'), 'a b c PATH');
  if (process.platform === 'win32') {
    const launched = processLaunch('C:\\npm\\claude.cmd', shim.args);
    assert.match(launched.executable, /powershell\.exe$/i);
    assert.match(Buffer.from(launched.args.at(-1)!, 'base64').toString('utf16le'), /^& 'C:\\npm\\claude\.cmd' 'Fix ''Buy'' at 100 pipe tag caret bang'; exit \$LASTEXITCODE$/);
  }
  assert.equal(laneLaunch({ ...base, platform: 'linux', executable: '/usr/bin/claude.cmd', connected: true, prompt: 'a & b' }).args[0], 'a & b', 'only Windows shims are sanitised');

  const test = laneLaunch({ ...base, testCommand: '["C:\\\\tools\\\\echo.cmd", "HYDRA-MARKER"]' });
  assert.deepEqual([test.executable, test.args], ['C:\\tools\\echo.cmd', ['HYDRA-MARKER']], 'the test hook replaces the CLI');
  assert.equal(test.env.HYDRA_LANE_ID, id);
  assert.deepEqual(parseTestCommand('  C:\\tools\\lane.cmd '), { executable: 'C:\\tools\\lane.cmd', args: [] });
  assert.throws(() => parseTestCommand('[1]'), /JSON array of strings/);
});

test('hydra_lanes is a lead action, and the lane guidance reaches both instruction paths', () => {
  assert.ok(leadTools.some(tool => tool.name === 'hydra_lanes'));
  assert.equal(toolAllowed('lead', 'hydra_lanes'), true);
  assert.equal(toolAllowed('helper', 'hydra_lanes'), false, 'a head cannot list lanes');
  assert.equal(laneGuidance('Lane 1', `lane/lane-1-${id}`), `You are in Hydra lane "Lane 1" on branch lane/lane-1-${id}. Call hydra_lanes before you start and before large changes; avoid editing files other lanes are changing, and tell the user if you must.`);
  assert.match(laneGuidance(), /^You are in a Hydra lane\. Call hydra_lanes/);
  assert.match(leadGuidanceMarkdown, /When you work in a Hydra lane \(your git branch starts with `lane\/`\): Call hydra_lanes before you start and before large changes; avoid editing files other lanes are changing, and tell the user if you must\./);
  assert.deepEqual(laneFromEnv({ HYDRA_LANE_ID: id, HYDRA_LANE_NAME: 'Lane "1"\n', HYDRA_LANE_BRANCH: `lane/lane-1-${id}` }), { id, name: 'Lane 1', branch: `lane/lane-1-${id}` });
  assert.deepEqual(laneFromEnv({ HYDRA_LANE_ID: id, HYDRA_LANE_BRANCH: 'main' }), { id }, 'a branch that isn\'t this lane\'s is ignored');
  for (const bad of ['', 'ABCDEF012345', 'abc', `${id}0`]) assert.equal(laneFromEnv({ HYDRA_LANE_ID: bad }), undefined);
});

test('a lane\'s bridge names its lane in the lead session, and the window keeps it only for an open lane', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-lane-bridge-'));
  const worktree = path.join(root, 'repo.worktrees', `lane-${id}`);
  await mkdir(path.join(worktree, 'src'), { recursive: true });
  const seen: HelperCaller[] = [];
  const open = new Set([id]);
  const endpoint = new HelperEndpoint(async caller => { seen.push(caller); return { lane: caller.lane ?? null }; }, { leadKey: 'window', verifyLead: async () => ({ ok: true }), laneExists: lane => open.has(lane) });
  const port = await endpoint.start();
  // What the bridge sends: a plain server captures the lead-session body.
  const bodies: string[] = [];
  const capture = http.createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8')); response.end('{"ok":false,"error":"captured"}'); }); });
  await new Promise<void>(resolve => capture.listen(0, '127.0.0.1', resolve));
  try {
    await requestLeadSession((capture.address() as { port: number }).port, 'codex', id);
    await requestLeadSession((capture.address() as { port: number }).port, 'claude', 'not-a-lane');
    assert.deepEqual(bodies.map(body => JSON.parse(body)), [{ provider: 'codex', lane: id }, { provider: 'claude' }]);

    // The discovery record lists the lane's worktree, so the bridge finds this window from inside it.
    await writeWindowRecord(root, { port, pid: process.pid, folders: [path.join(root, 'repo'), worktree] });
    assert.equal((await findWindowFor(root, path.join(worktree, 'src')))?.port, port);
    const env = { HYDRA_HELPERS_DIR: root, HYDRA_LEAD_PROVIDER: 'claude', HYDRA_LANE_ID: id, HYDRA_LANE_NAME: 'Lane 1', HYDRA_LANE_BRANCH: `lane/lane-1-${id}` };
    const bridge = createBridge({ env, cwd: path.join(worktree, 'src'), version: 'test' });
    const init = await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { result: { instructions: string } };
    assert.match(init.result.instructions, /hydra_start_head[\s\S]*You are in Hydra lane "Lane 1" on branch lane\/lane-1-abcdef012345\. Call hydra_lanes/);
    const called = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hydra_lanes', arguments: {} } }) as { result: { content: { text: string }[] } };
    assert.match(called.result.content[0]!.text, /"lane": "abcdef012345"/);
    assert.equal(seen.at(-1)!.lane, id);
    // The user-level server's HYDRA_HELPERS_DIR can belong to another Hydra profile; the lane's own directory wins.
    const otherProfile = createBridge({ env: { ...env, HYDRA_HELPERS_DIR: path.join(root, 'another-profile'), HYDRA_LANE_HELPERS_DIR: root }, cwd: path.join(worktree, 'src'), version: 'test' });
    const viaLaneDir = await otherProfile.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hydra_lanes', arguments: {} } }) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(viaLaneDir.result.isError, undefined, viaLaneDir.result.content[0]!.text);

    open.clear();
    const closed = createBridge({ env, cwd: worktree, version: 'test' });
    await closed.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hydra_list_heads', arguments: {} } });
    assert.equal(seen.at(-1)!.lane, undefined, 'a lane that isn\'t open here is dropped');
    const plain = createBridge({ env: { HYDRA_HELPERS_DIR: root, HYDRA_LANE_ID: 'nope' }, cwd: worktree, version: 'test' });
    const plainInit = await plain.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) as { result: { instructions: string } };
    assert.doesNotMatch(plainInit.result.instructions, /Hydra lane/, 'no lane, no lane guidance');
    const helper = createBridge({ env: { ...env, HYDRA_HELPER_PORT: String(port), HYDRA_HELPER_TOKEN: endpoint.issue({ role: 'helper', leadKey: 'window', jobId: 'cccccccccccc' }) }, cwd: worktree, version: 'test' });
    const helperInit = await helper.handle({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }) as { result: { instructions: string } };
    assert.doesNotMatch(helperInit.result.instructions, /Hydra lane/, 'a head never gets lane guidance');
  } finally { capture.close(); await endpoint.close(); await rm(root, { recursive: true, force: true }); }
});
