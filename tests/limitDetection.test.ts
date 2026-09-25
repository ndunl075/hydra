import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addClaudeLimitHook, claudeSupportsLimitHook, isHydraLimitGroup, limitHookGroup, limitHookState, readClaudeLimitHooks, removeClaudeLimitHook, type LimitHookGroup } from '../src/core/claudeLimitHook';
import { addClaudeAllowRule, claudeWrittenLimitHook, connectClaude, disconnectClaude, helperWrittenEntries, providerPaths, removeClaudeAllowRule, setClaudeLimitHook } from '../src/core/helperRegistration';
import { claudeHeadLimit, codexHeadLimit, codexLimitState, codexPollDelay, CodexLimitTracker, headLimitReason, normaliseStopFailure, parseLimitEventFile } from '../src/core/limitDetection';
import { LimitWatcher, workspaceOwns } from '../src/core/limitWatcher';
import { publicCodexQuota, type QuotaSnapshot } from '../src/core/quota';
import type { LimitEvent } from '../src/core/limitEvents';

const hydra = 'C:\\Program Files\\Hydra\\Hydra.exe';
const group = limitHookGroup({ executable: hydra, script: 'C:\\Program Files\\Hydra\\resources\\app\\extensions\\hydra\\dist\\hydra-limit-hook.cjs', eventsDir: "C:\\Users\\O'Brien\\AppData\\Roaming\\Hydra\\User\\globalStorage\\hydra\\limit-events", platform: 'win32', systemRoot: 'C:\\Windows' });
const moved = limitHookGroup({ executable: 'D:\\Hydra\\Hydra.exe', script: 'D:\\Hydra\\dist\\hydra-limit-hook.cjs', eventsDir: 'C:\\x\\limit-events', platform: 'win32', systemRoot: 'C:\\Windows' });
const userGroup = { matcher: 'rate_limit', hooks: [{ type: 'command', command: 'notify-send limited' }] };

test('the hook command runs Hydra as Node without a shell parsing its paths', () => {
  const hook = group.hooks[0]!;
  assert.equal(group.matcher, 'rate_limit');
  assert.equal(hook.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(hook.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(hook.args[4], "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Hydra\\Hydra.exe' 'C:\\Program Files\\Hydra\\resources\\app\\extensions\\hydra\\dist\\hydra-limit-hook.cjs' 'C:\\Users\\O''Brien\\AppData\\Roaming\\Hydra\\User\\globalStorage\\hydra\\limit-events'; exit 0");
  assert.match(limitHookGroup({ executable: 'C:\\a\u2019b\\Hydra.exe', script: 's', eventsDir: 'e', platform: 'win32' }).hooks[0]!.args[4]!, /'C:\\a\u2019\u2019b\\Hydra\.exe'/, 'typographic quotes are escaped too');
  const unix = limitHookGroup({ executable: '/opt/Hydra/hydra', script: '/opt/it\'s/hydra-limit-hook.cjs', eventsDir: '/home/n/.config/Hydra/limit-events', platform: 'linux' }).hooks[0]!;
  assert.deepEqual([unix.command, ...unix.args], ['/bin/sh', '-c', 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"', '/opt/Hydra/hydra', '/opt/it\'s/hydra-limit-hook.cjs', '/home/n/.config/Hydra/limit-events']);
  assert.equal(hook.timeout, 30);
  assert.ok(isHydraLimitGroup(group) && !isHydraLimitGroup(userGroup));
  assert.equal(claudeSupportsLimitHook('2.1.270 (Claude Code)'), true);
  assert.equal(claudeSupportsLimitHook('2.1.139 (Claude Code)'), true);
  assert.equal(claudeSupportsLimitHook('2.1.138 (Claude Code)'), false);
  assert.equal(claudeSupportsLimitHook('3.0.0'), true);
  assert.equal(claudeSupportsLimitHook('garbage'), false);
});

test('the StopFailure hook is inserted and removed byte-exactly, next to the user\'s own settings', () => {
  const samples: Record<string, string> = {
    'no hooks key': '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test)"\n    ]\n  },\n  "model": "opus"\n}\n',
    'hooks for other events': '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "Bash",\n        "hooks": [{ "type": "command", "command": "echo hi" }]\n      }\n    ]\n  }\n}\n',
    'user StopFailure entries': `{\n    "hooks": {\n        "StopFailure": [\n            ${JSON.stringify(userGroup)}\n        ]\n    }\n}`,
    'empty StopFailure list': '{\n  "hooks": {\n    "StopFailure": []\n  },\n  "theme": "dark"\n}\n',
    'CRLF': '{\r\n  "model": "opus",\r\n  "hooks": {\r\n    "Stop": []\r\n  }\r\n}\r\n',
    'compact JSON': '{"model":"opus","permissions":{"allow":["Read"]}}',
    'compact with hooks': '{"hooks":{"StopFailure":[{"matcher":"overloaded","hooks":[]}]}}',
    'allow rule already present': addClaudeAllowRule('{\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n'),
    'tabs and a BOM': '\uFEFF{\n\t"model": "opus"\n}\n',
  };
  for (const [name, original] of Object.entries(samples)) {
    const added = addClaudeLimitHook(original, group);
    const parsed = JSON.parse(added.replace(/^\uFEFF/, '')) as { hooks: { StopFailure: unknown[] } };
    assert.deepEqual(parsed.hooks.StopFailure.at(-1), group, `${name}: Hydra's group is last`);
    assert.deepEqual(JSON.parse(removeClaudeLimitHook(added).text!.replace(/^\uFEFF/, '')), JSON.parse(original.replace(/^\uFEFF/, '')), `${name}: same settings`);
    assert.equal(removeClaudeLimitHook(added).text, original, `${name}: byte-identical after removal`);
    assert.equal(addClaudeLimitHook(added, group), added, `${name}: connecting twice changes nothing`);
    assert.equal(limitHookState(added, group), 'current');
    const upgraded = addClaudeLimitHook(added, moved);
    assert.equal(readClaudeLimitHooks(upgraded).length, 1, `${name}: an upgrade replaces the old group`);
    assert.equal(limitHookState(upgraded, group), 'stale'); assert.equal(limitHookState(upgraded, moved), 'current');
    assert.equal(removeClaudeLimitHook(upgraded).text, original, `${name}: byte-identical after an upgrade and removal`);
    if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(added), `${name}: CRLF kept`);
    if (!original.includes('\n')) assert.ok(!added.includes('\n'), `${name}: compact stays compact`);
  }
  // An empty "hooks": {} reads the same as none once filled: removal gives equal settings, not the same bytes.
  const emptyHooks = '{\n  "model": "opus",\n  "hooks": {}\n}\n';
  assert.deepEqual(JSON.parse(removeClaudeLimitHook(addClaudeLimitHook(emptyHooks, group)).text!), { model: 'opus' });
  assert.equal(removeClaudeLimitHook(samples['user StopFailure entries']).had, false);
  assert.equal(removeClaudeLimitHook(undefined).text, undefined);
  assert.deepEqual(JSON.parse(addClaudeLimitHook(undefined, group)), { hooks: { StopFailure: [group] } });
  assert.deepEqual(JSON.parse(addClaudeLimitHook('  ', group)), { hooks: { StopFailure: [group] } });
  assert.throws(() => addClaudeLimitHook('{"hooks": []}', group), /not an object/);
  assert.throws(() => addClaudeLimitHook('{"hooks": {"StopFailure": {}}}', group), /not a list/);
  assert.throws(() => addClaudeLimitHook('{"a": ', group));
});

test('a hand-edited file still loses only Hydra\'s group', () => {
  const added = addClaudeLimitHook('{\n  "hooks": {\n    "StopFailure": [\n      {"matcher": "rate_limit", "hooks": []}\n    ]\n  }\n}\n', group);
  // The user adds their own group after Hydra's.
  const edited = added.replace(/\n    \]\n  \}/, `,\n      ${JSON.stringify(userGroup)}\n    ]\n  }`);
  const removed = removeClaudeLimitHook(edited);
  assert.equal(removed.had, true);
  assert.deepEqual(JSON.parse(removed.text!).hooks.StopFailure, [{ matcher: 'rate_limit', hooks: [] }, userGroup]);
  // Two Hydra installs wrote a group each: both go.
  const twice = addClaudeLimitHook(edited, group).replace(/\n    \]\n  \}/, `,\n      ${JSON.stringify(moved)}\n    ]\n  }`);
  assert.equal(readClaudeLimitHooks(twice).length, 2);
  assert.equal(readClaudeLimitHooks(removeClaudeLimitHook(twice).text).length, 0);
  assert.equal(readClaudeLimitHooks(addClaudeLimitHook(twice, group)).length, 1);
});

test('connect writes the allow rule and the hook; disconnect restores settings.json byte for byte', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-hook-'));
  try {
    const paths = providerPaths({ CLAUDE_CONFIG_DIR: directory, CODEX_HOME: directory });
    assert.equal(paths.claudeProjects, path.join(directory, 'projects'));
    const original = '{\r\n  "permissions": {\r\n    "allow": [\r\n      "Read"\r\n    ]\r\n  },\r\n  "hooks": {\r\n    "Stop": [\r\n      {\r\n        "hooks": [\r\n          { "type": "command", "command": "say done" }\r\n        ]\r\n      }\r\n    ]\r\n  }\r\n}\r\n';
    await writeFile(paths.claudeSettings, original);
    // A fake `claude` that accepts `mcp add-json` / `mcp remove`.
    const fake = path.join(directory, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    await writeFile(fake, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await connectClaude(fake, paths, { command: hydra, args: ['x'], env: {} }, group);
    const connected = await readFile(paths.claudeSettings, 'utf8');
    assert.equal(removeClaudeAllowRule(removeClaudeLimitHook(connected).text), original);
    assert.match((await claudeWrittenLimitHook(paths))!, /hydra-limit-hook/);
    assert.match((await helperWrittenEntries(paths, (_key, value) => value)).claude.limitHook!, /"matcher": "rate_limit"/);
    await setClaudeLimitHook(paths, moved);
    assert.equal(limitHookState(await readFile(paths.claudeSettings, 'utf8'), moved), 'current');
    await disconnectClaude(fake, paths);
    assert.equal(await readFile(paths.claudeSettings, 'utf8'), original);
    assert.equal(await claudeWrittenLimitHook(paths), undefined);
    await connectClaude(fake, paths, { command: hydra, args: ['x'], env: {} });
    assert.equal(limitHookState(await readFile(paths.claudeSettings, 'utf8'), group), 'missing', 'an old Claude gets no hook');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Recorded from Claude Code 2.1.270 against a server answering 429 (see core/limitDetection.ts).
const stopFailure = {
  session_id: '799cd1b7-72e7-4d23-8276-9de3ee3e56b0',
  transcript_path: 'C:\\Users\\n\\.claude\\projects\\C--repo\\799cd1b7-72e7-4d23-8276-9de3ee3e56b0.jsonl',
  cwd: 'C:\\repo', prompt_id: '8692b0b9-a8b0-47ea-b213-23b3e9acdaa7', hook_event_name: 'StopFailure', error: 'rate_limit',
  last_assistant_message: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
};

test('the hook payload is normalised into a LimitEvent, and garbage is refused', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  assert.deepEqual(normaliseStopFailure(stopFailure, now), {
    provider: 'claude', source: 'chat', at: '2026-09-24T12:00:00.000Z', message: stopFailure.last_assistant_message,
    sessionId: stopFailure.session_id, cwd: 'C:\\repo', transcriptPath: stopFailure.transcript_path,
  });
  assert.equal(normaliseStopFailure({ ...stopFailure, last_assistant_message: 'Claude AI usage limit reached|1790000000' }, now)?.resetsAt, new Date(1790000000 * 1000).toISOString());
  for (const bad of [null, 'x', [], 42, {}, { ...stopFailure, error: 'overloaded' }, { ...stopFailure, hook_event_name: 'Stop' }]) assert.equal(normaliseStopFailure(bad, now), undefined);
  const odd = normaliseStopFailure({ ...stopFailure, session_id: '../../etc', cwd: 'relative\\dir', transcript_path: 7, last_assistant_message: `a\u0000b${'x'.repeat(5000)}` }, now)!;
  assert.equal(odd.sessionId, undefined); assert.equal(odd.cwd, undefined); assert.equal(odd.transcriptPath, undefined);
  assert.ok(odd.message!.startsWith('a b') && odd.message!.length <= 2001);
});

test('event files are validated like untrusted input', () => {
  const now = Date.parse('2026-09-24T12:00:00.000Z'), projects = 'C:\\Users\\n\\.claude\\projects';
  const event = normaliseStopFailure(stopFailure, new Date(now))!;
  const parse = (value: unknown) => parseLimitEventFile(typeof value === 'string' ? value : JSON.stringify(value), { now, claudeProjectsDir: projects });
  if (process.platform === 'win32') assert.deepEqual(parse(event), event);
  assert.equal(parse({ ...event, transcriptPath: 'C:\\Windows\\win.ini' })?.transcriptPath, undefined, 'a transcript outside Claude\'s projects is dropped');
  assert.equal(parse({ ...event, transcriptPath: `${projects}\\..\\secrets.jsonl` })?.transcriptPath, undefined);
  assert.equal(parse({ ...event, at: '2026-09-24T11:40:00.000Z' }), undefined, 'too old');
  assert.equal(parse({ ...event, at: '2026-09-24T12:10:00.000Z' }), undefined, 'from the future');
  assert.equal(parse({ ...event, provider: 'codex' }), undefined);
  assert.equal(parse({ ...event, source: 'head' }), undefined);
  assert.equal(parse('not json'), undefined); assert.equal(parse('[]'), undefined);
  assert.equal(parse(JSON.stringify({ ...event, message: 'x'.repeat(70_000) })), undefined, 'oversized');
  assert.equal(parse({ ...event, resetsAt: 'soon' })?.resetsAt, undefined);
});

test('the built hook script writes one event file and never fails', { skip: !existsSync('dist/hydra-limit-hook.cjs') && 'build first' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra hook \'s events-'));
  try {
    const events = path.join(directory, 'limit-events');
    const run = (input: string, args = [events]) => spawnSync(process.execPath, ['dist/hydra-limit-hook.cjs', ...args], { input, timeout: 10_000 });
    assert.equal(run(JSON.stringify(stopFailure)).status, 0);
    const names = await readdir(events);
    assert.equal(names.length, 1); assert.match(names[0]!, /^\d{13}-[0-9a-f]{16}\.json$/);
    assert.equal((JSON.parse(await readFile(path.join(events, names[0]!), 'utf8')) as LimitEvent).sessionId, stopFailure.session_id);
    for (const input of ['', 'garbage', JSON.stringify({ ...stopFailure, error: 'overloaded' }), 'x'.repeat(400_000)]) assert.equal(run(input).status, 0);
    assert.equal(run(JSON.stringify(stopFailure), []).status, 0, 'no folder given');
    assert.equal((await readdir(events)).length, 1, 'nothing else was written');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the watcher claims events for its own folders, lets other windows go first, and cleans up', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-limits-'));
  const events = path.join(root, 'events'), projects = path.join(root, 'claude', 'projects');
  let now = Date.now();
  const drop = async (event: Partial<LimitEvent>, at = now) => {
    const name = `${at}-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}.json`;
    await writeFile(path.join(events, name), JSON.stringify({ provider: 'claude', source: 'chat', at: new Date(at).toISOString(), ...event }));
    return name;
  };
  const windowA = new LimitWatcher({ directory: events, claudeProjectsDir: projects, owns: workspaceOwns([path.join(root, 'repo-a')]), now: () => now, graceMs: 1000, scanMs: 60_000 });
  const windowB = new LimitWatcher({ directory: events, claudeProjectsDir: projects, owns: workspaceOwns([path.join(root, 'repo-b')]), now: () => now, graceMs: 1000, scanMs: 60_000 });
  const seenA: LimitEvent[] = [], seenB: LimitEvent[] = [];
  windowA.onLimit(event => seenA.push(event)); windowB.onLimit(event => seenB.push(event));
  try {
    await mkdir(events, { recursive: true });
    await windowA.start(); await windowB.start();
    // Window B sees the event first but it belongs to A's folder: B waits, A claims it.
    await drop({ sessionId: 's1', cwd: path.join(root, 'repo-a', 'src'), transcriptPath: path.join(projects, 'x', 's1.jsonl') });
    await windowB.scan(); assert.equal(seenB.length, 0);
    await windowA.scan(); assert.equal(seenA.length, 1); assert.equal(seenA[0]!.transcriptPath, path.join(projects, 'x', 's1.jsonl'));
    assert.deepEqual(await readdir(events), [], 'the claimed file is gone');
    // Nobody's folder: after the grace period the first window to look takes it.
    await drop({ sessionId: 's2', cwd: path.join(root, 'elsewhere') });
    await windowA.scan(); await windowB.scan(); assert.equal(seenA.length + seenB.length, 1);
    now += 1500;
    await Promise.all([windowB.scan(), windowA.scan()]);
    assert.equal(seenA.length + seenB.length, 2, 'exactly one window took it');
    // The same chat again within two minutes is a repeat.
    await drop({ sessionId: 's1', cwd: path.join(root, 'repo-a') });
    await windowA.scan(); assert.equal(seenA.filter(event => event.sessionId === 's1').length, 1);
    // Garbage, stale and leftover files are removed.
    await writeFile(path.join(events, `${now}-0123456789abcdef.json`), '{"provider":"evil"}');
    await drop({ sessionId: 's3', cwd: path.join(root, 'repo-a') }, now - 11 * 60_000);
    const leftover = path.join(events, `${now}-aaaaaaaaaaaaaaaa.tmp`);
    await writeFile(leftover, '{'); await utimes(leftover, new Date(now - 120_000), new Date(now - 120_000));
    await writeFile(path.join(events, 'README.txt'), 'not ours');
    await windowA.scan();
    assert.deepEqual(await readdir(events), ['README.txt']);
    assert.equal(seenA.filter(event => event.sessionId === 's3').length, 0);
    // A transcript outside Claude's projects is dropped, the event kept.
    await drop({ sessionId: 's4', cwd: path.join(root, 'repo-a'), transcriptPath: path.join(root, 'secret.jsonl') });
    await windowA.scan();
    const s4 = seenA.find(event => event.sessionId === 's4')!;
    assert.ok(s4 && s4.transcriptPath === undefined);
    // The file watcher picks up a new file without a manual scan.
    await drop({ sessionId: 's5', cwd: path.join(root, 'repo-a') });
    const deadline = Date.now() + 20_000;
    while (!seenA.some(event => event.sessionId === 's5') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(seenA.some(event => event.sessionId === 's5'), 'fs.watch noticed the file');
  } finally { windowA.dispose(); windowB.dispose(); await rm(root, { recursive: true, force: true }); }
});

const quota = (reached: string | null, used: number, resetsAt = 1790000000): QuotaSnapshot => publicCodexQuota({
  ordinaryUsageAllowed: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
  rateLimits: { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: used, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: resetsAt + 86400 }, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: reached },
  rateLimitsByLimitId: null,
});

test('Codex: one event when a limit is reached, none again until it clears', () => {
  assert.deepEqual(codexLimitState(quota(null, 50)), { limited: false });
  assert.equal(quota('rate_limit_reached', 50).buckets[0]!.reached, 'rate_limit_reached');
  assert.equal(quota('something_new', 50).buckets[0]!.reached, undefined, 'unknown values are not kept');
  const full = codexLimitState(quota(null, 100));
  assert.equal(full.limited, true); assert.equal(full.resetsAt, new Date(1790000000 * 1000).toISOString(), 'the full window\'s reset');
  assert.equal(codexLimitState(quota('workspace_member_usage_limit_reached', 80)).resetsAt, new Date((1790000000 + 86400) * 1000).toISOString(), 'reached with no full window: the last reset');
  const tracker = new CodexLimitTracker(), at = new Date('2026-09-24T12:00:00.000Z');
  assert.equal(tracker.observe(quota(null, 60), at), undefined);
  const event = tracker.observe(quota('rate_limit_reached', 100), at)!;
  assert.deepEqual({ provider: event.provider, source: event.source, at: event.at }, { provider: 'codex', source: 'chat', at: at.toISOString() });
  assert.match(event.message!, /rate_limit_reached/); assert.ok(event.resetsAt);
  assert.equal(tracker.observe(quota('rate_limit_reached', 100), at), undefined, 'still limited: no repeat');
  assert.equal(tracker.observe(quota(null, 3), at), undefined); assert.equal(tracker.isLimited, false);
  assert.ok(tracker.observe(quota(null, 100), at), 'limited again after clearing');
  assert.equal(codexPollDelay(0, 'ok'), 300_000); assert.equal(codexPollDelay(300_000, 'limited'), 600_000);
  assert.equal(codexPollDelay(300_000, 'failed'), 600_000); assert.equal(codexPollDelay(1_200_000, 'failed'), 1_800_000); assert.equal(codexPollDelay(1_800_000, 'failed'), 1_800_000);
});

test('heads: a usage limit is recognised from the CLIs\' own lines', () => {
  // Recorded from `claude -p --output-format stream-json` (2.1.270) against a 429.
  const retry = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: 583, error_status: 429, error: 'rate_limit', session_id: 's' };
  const text = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
  const assistant = { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }, error: 'rate_limit', is_api_error_message: true };
  const result = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: text, terminal_reason: 'api_error' };
  assert.equal(claudeHeadLimit(retry), undefined, 'a retry is not a limit yet');
  assert.deepEqual(claudeHeadLimit(assistant), { message: text });
  assert.deepEqual(claudeHeadLimit(result), { message: text });
  assert.deepEqual(claudeHeadLimit({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1790000000' }), { message: 'Claude AI usage limit reached|1790000000', resetsAt: new Date(1790000000 * 1000).toISOString() });
  assert.equal(claudeHeadLimit({ type: 'result', is_error: true, result: 'Not logged in · Please run /login', api_error_status: null }), undefined);
  assert.equal(claudeHeadLimit({ type: 'result', is_error: false, result: 'I checked the rate limit code.' }), undefined);
  assert.equal(claudeHeadLimit({ type: 'assistant', message: { content: [{ type: 'text', text: 'usage limit' }] } }), undefined);
  const codex = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:04 PM.";
  assert.deepEqual(codexHeadLimit({ type: 'error', message: codex }), { message: codex });
  assert.deepEqual(codexHeadLimit({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }), { message: 'exceeded retry limit, last status: 429 Too Many Requests' });
  assert.equal(codexHeadLimit({ type: 'turn.failed', error: { message: 'sandbox denied' } }), undefined);
  assert.equal(codexHeadLimit({ type: 'item.completed', item: { type: 'agent_message', text: codex } }), undefined, 'the agent talking about limits is not one');
  assert.match(headLimitReason('claude', { message: 'x', resetsAt: '2026-09-24T15:00:00.000Z' }), /^Claude usage limit reached \(resets 2026-09-24T15:00:00\.000Z\): x$/);
});
