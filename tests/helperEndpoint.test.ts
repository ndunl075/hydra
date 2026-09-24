import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HelperEndpoint, callHelperEndpoint, requestLeadSession, type HelperCaller } from '../src/core/helperEndpoint';
import { chainProvider, createLeadVerifier, evaluateLeadChain, windowsConnectionChain } from '../src/core/leadVerification';
import { discoveryDirectory, findWindowFor, removeWindowRecord, writeWindowRecord } from '../src/core/helperDiscovery';
import { createBridge } from '../src/core/mcpBridge';
import { helperTools, leadTools } from '../src/core/helperTools';

function raw(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hydra/v1/call', headers: { 'content-type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('the endpoint refuses wrong tokens, other roles\' actions, browsers, foreign hosts, big bodies and floods', async () => {
  const seen: [HelperCaller, string][] = [];
  const endpoint = new HelperEndpoint(async (caller, tool) => { seen.push([caller, tool]); return { handled: tool }; }, { maxBodyBytes: 1024, callsPerMinute: 5 });
  const port = await endpoint.start();
  try {
    const lead = endpoint.issue({ role: 'lead', leadKey: 'window-a' });
    const helper = endpoint.issue({ role: 'helper', leadKey: 'window-a', jobId: 'aaaaaaaaaaaa' });
    assert.deepEqual(await callHelperEndpoint(port, lead, 'hydra_list_heads', {}), { ok: true, result: { handled: 'hydra_list_heads' } });
    assert.equal(seen[0]![0].role, 'lead'); assert.equal(seen[0]![0].leadKey, 'window-a');
    assert.match((await callHelperEndpoint(port, 'x'.repeat(43), 'hydra_list_heads', {})).error || '', /Unknown Hydra token/);
    assert.equal((await raw(port, {}, '{"tool":"hydra_list_heads"}')).status, 401);
    const denied = await callHelperEndpoint(port, helper, 'hydra_start_head', {});
    assert.equal(denied.ok, false); assert.match(denied.error || '', /not available to a Hydra head/);
    assert.match((await callHelperEndpoint(port, lead, 'hydra_done', {})).error || '', /not available to a Hydra lead/);
    assert.equal((await raw(port, { authorization: `Bearer ${lead}`, origin: 'https://evil.example' }, '{"tool":"hydra_list_heads"}')).status, 403);
    assert.equal((await raw(port, { authorization: `Bearer ${lead}`, host: `localhost:${port}` }, '{"tool":"hydra_list_heads"}')).status, 403);
    assert.equal((await raw(port, { authorization: `Bearer ${helper}` }, JSON.stringify({ tool: 'hydra_progress', arguments: { note: 'x'.repeat(2000) } }))).status, 413);
    const flood = [];
    for (let index = 0; index < 6; index++) flood.push((await raw(port, { authorization: `Bearer ${helper}` }, '{"tool":"hydra_progress","arguments":{"note":"x"}}')).status);
    assert.ok(flood.includes(429), `a flood is capped: ${flood}`);
    endpoint.revokeJob('aaaaaaaaaaaa');
    assert.match((await callHelperEndpoint(port, helper, 'hydra_progress', { note: 'x' })).error || '', /Unknown Hydra token/);
    // Handler errors come back as tool errors, not transport failures.
    const failing = new HelperEndpoint(async () => { throw new Error('No such job.'); });
    const failingPort = await failing.start();
    try { assert.deepEqual(await callHelperEndpoint(failingPort, failing.issue({ role: 'lead', leadKey: 'k' }), 'hydra_get_head', { job_id: 'aaaaaaaaaaaa' }), { ok: false, error: 'No such job.' }); }
    finally { await failing.close(); }
  } finally { await endpoint.close(); }
});

test('a caller that disconnects cancels its long call', async () => {
  let aborted = false;
  const endpoint = new HelperEndpoint((_caller, _tool, _args, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve('stopped'); }); }));
  const port = await endpoint.start();
  try {
    const controller = new AbortController();
    const call = callHelperEndpoint(port, endpoint.issue({ role: 'lead', leadKey: 'k' }), 'hydra_wait_for_heads', { job_ids: ['aaaaaaaaaaaa'] }, controller.signal).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort(); await call;
    for (let index = 0; index < 50 && !aborted; index++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(aborted, true);
  } finally { await endpoint.close(); }
});

test('the bridge picks the right window by folder, ignores dead windows, and explains when none is open', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-helpers-'));
  const repoA = path.join(root, 'repo-a'), repoB = path.join(root, 'repo-b'), nested = path.join(repoA, 'packages', 'inner');
  await mkdir(nested, { recursive: true }); await mkdir(repoB, { recursive: true });
  const accept = async () => ({ ok: true as const });
  const windowA = new HelperEndpoint(async (caller, tool) => ({ window: 'A', tool, leadKey: caller.leadKey }), { leadKey: 'A', verifyLead: accept });
  const windowB = new HelperEndpoint(async () => ({ window: 'B' }), { leadKey: 'B', verifyLead: accept });
  const [portA, portB] = [await windowA.start(), await windowB.start()];
  try {
    const recordA = await writeWindowRecord(root, { port: portA, pid: process.pid, folders: [repoA] });
    await writeWindowRecord(root, { port: portB, pid: process.pid, folders: [repoB] });
    assert.doesNotMatch(await readFile(recordA, 'utf8'), /token/i, 'the discovery file holds no secret');
    await writeFile(path.join(discoveryDirectory(root), 'dead.json'), JSON.stringify({ version: 2, port: 1, pid: 999999, folders: [nested], writtenAt: '' }));
    assert.equal((await findWindowFor(root, nested))?.port, portA, 'a dead window with a deeper folder is ignored');
    assert.ok(!(await readdir(discoveryDirectory(root))).includes('dead.json'), 'dead records are cleaned up');
    assert.equal((await findWindowFor(root, repoB))?.port, portB);
    assert.equal(await findWindowFor(root, path.join(root, 'elsewhere')), undefined);

    const lead = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: nested, version: 'test' });
    const init = await lead.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) as { result: { protocolVersion: string; instructions: string } };
    assert.equal(init.result.protocolVersion, '2025-11-25'); assert.match(init.result.instructions, /hydra_start_head/);
    const listed = await lead.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map(tool => tool.name), leadTools.map(tool => tool.name));
    const called = await lead.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hydra_list_heads', arguments: {} } }) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(called.result.isError, undefined); assert.match(called.result.content[0]!.text, /"window": "A"/);
    assert.equal(await lead.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);

    const lost = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: path.join(root, 'elsewhere'), version: 'test' });
    const refused = await lost.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hydra_list_heads', arguments: {} } }) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(refused.result.isError, true); assert.match(refused.result.content[0]!.text, /Hydra isn't open for this folder/);
    const notSetUp = createBridge({ env: {}, cwd: repoA, version: 'test' });
    assert.match(JSON.stringify(await notSetUp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hydra_list_heads' } })), /Connect Claude Code or Codex to Hydra/);

    const helper = createBridge({ env: { HYDRA_HELPER_PORT: String(portA), HYDRA_HELPER_TOKEN: windowA.issue({ role: 'helper', leadKey: 'A', jobId: 'bbbbbbbbbbbb' }) }, cwd: repoB, version: 'test' });
    const helperList = await helper.handle({ jsonrpc: '2.0', id: 6, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    assert.deepEqual(helperList.result.tools.map(tool => tool.name), helperTools.map(tool => tool.name), 'a helper sees only helper actions, whatever folder it runs in');
    const leadOnly = await helper.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hydra_start_head', arguments: {} } }) as { result: { isError: boolean } };
    assert.equal(leadOnly.result.isError, true);
    await removeWindowRecord(recordA);
    assert.equal(await findWindowFor(root, repoA), undefined);
  } finally { await windowA.close(); await windowB.close(); await rm(root, { recursive: true, force: true }); }
});

test('a lead token is issued only to a process that passes the window\'s lead check', async () => {
  let allow = false;
  const endpoint = new HelperEndpoint(async caller => ({ role: caller.role }), { leadKey: 'window', verifyLead: async () => allow ? { ok: true } : { ok: false, reason: 'it runs inside a Hydra head.' } });
  const port = await endpoint.start();
  try {
    const refused = await requestLeadSession(port);
    assert.equal(refused.ok, false); assert.match(refused.error || '', /Hydra refused this lead: it runs inside a Hydra head/);
    allow = true;
    const granted = await requestLeadSession(port);
    const token = (granted.result as { token: string }).token;
    assert.deepEqual(await callHelperEndpoint(port, token, 'hydra_list_heads', {}), { ok: true, result: { role: 'lead' } });
    const noVerifier = new HelperEndpoint(async () => 'x');
    const otherPort = await noVerifier.start();
    try { assert.match((await requestLeadSession(otherPort)).error || '', /does not accept lead connections/); } finally { await noVerifier.close(); }
  } finally { await endpoint.close(); }
});

test('the lead check refuses helper descendants, detached processes and reused PIDs', () => {
  const rules = { allowedAncestors: new Set([100]), deniedAncestors: new Set([300]) };
  const link = (pid: number, ppid: number, created: number) => ({ pid, ppid, created });
  // bridge 500 <- claude 400 <- extension host 100: accepted.
  assert.deepEqual(evaluateLeadChain([link(500, 400, 30), link(400, 100, 20), link(100, 1, 10)], rules), { ok: true });
  // bridge <- tool 450 <- helper 300 <- extension host 100: refused as a helper.
  assert.match((evaluateLeadChain([link(500, 450, 40), link(450, 300, 30), link(300, 100, 20), link(100, 1, 10)], rules) as { reason: string }).reason, /inside a Hydra head/);
  // Detached: its parent is gone, so the chain never reaches the window.
  assert.match((evaluateLeadChain([link(500, 777, 40)], rules) as { reason: string }).reason, /not started from this Hydra window/);
  // A reused PID: the "parent" was created after the child, so the chain ends there.
  assert.equal(evaluateLeadChain([link(500, 100, 10), link(100, 1, 99)], rules).ok, false);
  assert.equal(evaluateLeadChain([], rules).ok, false);
});

test('on Windows the lead check reads the real connection owner and its parents', { skip: process.platform !== 'win32' }, async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const accepted = new Promise<import('node:net').Socket>(resolve => server.once('connection', resolve));
  const client = net.connect(port, '127.0.0.1');
  try {
    const socket = await accepted;
    const chain = await windowsConnectionChain(socket);
    assert.equal(chain[0]?.pid, process.pid, 'the owner of the client end is this process');
    assert.deepEqual(await createLeadVerifier(() => ({ allowedAncestors: new Set([process.pid]), deniedAncestors: new Set() }))(socket), { ok: true });
    assert.equal((await createLeadVerifier(() => ({ allowedAncestors: new Set([process.pid]), deniedAncestors: new Set([process.pid]) }))(socket)).ok, false);
  } finally { client.destroy(); server.close(); }
});

test('each lead bridge gets its own session, tagged with the agent it serves', async () => {
  const seen: HelperCaller[] = [];
  let chainSays: 'claude' | 'codex' | undefined;
  const endpoint = new HelperEndpoint(async caller => { seen.push(caller); return 'ok'; }, { leadKey: 'window', verifyLead: async () => chainSays ? { ok: true, provider: chainSays } : { ok: true } });
  const port = await endpoint.start();
  try {
    const claude = await requestLeadSession(port, 'claude');
    const codex = await requestLeadSession(port, 'codex');
    const [a, b] = [claude, codex].map(session => session.result as { token: string; session: string });
    assert.match(a!.session, /^[a-f0-9]{12}$/); assert.notEqual(a!.session, b!.session, 'one session per bridge');
    await callHelperEndpoint(port, a!.token, 'hydra_list_heads', {});
    await callHelperEndpoint(port, b!.token, 'hydra_list_heads', {});
    assert.deepEqual(seen.map(caller => [caller.leadSessionId, caller.provider]), [[a!.session, 'claude'], [b!.session, 'codex']]);
    chainSays = 'codex';
    const undeclared = (await requestLeadSession(port)).result as { token: string };
    await callHelperEndpoint(port, undeclared.token, 'hydra_list_heads', {});
    assert.equal(seen.at(-1)!.provider, 'codex', 'without a declared agent, the process chain decides');
    chainSays = undefined;
    const unknown = (await requestLeadSession(port)).result as { token: string };
    await callHelperEndpoint(port, unknown.token, 'hydra_list_heads', {});
    assert.equal(seen.at(-1)!.provider, undefined);
  } finally { await endpoint.close(); }
  const link = (pid: number, ppid: number, name: string) => ({ pid, ppid, created: 10, name });
  assert.equal(chainProvider([link(3, 2, 'node.exe'), link(2, 1, 'claude.exe'), link(1, 0, 'Hydra.exe')]), 'claude');
  assert.equal(chainProvider([link(3, 2, 'codex.exe')]), 'codex');
  assert.equal(chainProvider([link(3, 2, 'powershell.exe')]), undefined);
});
