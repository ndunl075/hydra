import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HelperEndpoint, callHelperEndpoint, type HelperCaller } from '../src/core/helperEndpoint';
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
    assert.deepEqual(await callHelperEndpoint(port, lead, 'hydra_list_helpers', {}), { ok: true, result: { handled: 'hydra_list_helpers' } });
    assert.equal(seen[0]![0].role, 'lead'); assert.equal(seen[0]![0].leadKey, 'window-a');
    assert.match((await callHelperEndpoint(port, 'x'.repeat(43), 'hydra_list_helpers', {})).error || '', /Unknown Hydra token/);
    assert.equal((await raw(port, {}, '{"tool":"hydra_list_helpers"}')).status, 401);
    const denied = await callHelperEndpoint(port, helper, 'hydra_start_helper', {});
    assert.equal(denied.ok, false); assert.match(denied.error || '', /not available to a Hydra helper/);
    assert.match((await callHelperEndpoint(port, lead, 'hydra_done', {})).error || '', /not available to a Hydra lead/);
    assert.equal((await raw(port, { authorization: `Bearer ${lead}`, origin: 'https://evil.example' }, '{"tool":"hydra_list_helpers"}')).status, 403);
    assert.equal((await raw(port, { authorization: `Bearer ${lead}`, host: `localhost:${port}` }, '{"tool":"hydra_list_helpers"}')).status, 403);
    assert.equal((await raw(port, { authorization: `Bearer ${helper}` }, JSON.stringify({ tool: 'hydra_progress', arguments: { note: 'x'.repeat(2000) } }))).status, 413);
    const flood = [];
    for (let index = 0; index < 6; index++) flood.push((await raw(port, { authorization: `Bearer ${helper}` }, '{"tool":"hydra_progress","arguments":{"note":"x"}}')).status);
    assert.ok(flood.includes(429), `a flood is capped: ${flood}`);
    endpoint.revokeJob('aaaaaaaaaaaa');
    assert.match((await callHelperEndpoint(port, helper, 'hydra_progress', { note: 'x' })).error || '', /Unknown Hydra token/);
    // Handler errors come back as tool errors, not transport failures.
    const failing = new HelperEndpoint(async () => { throw new Error('No such job.'); });
    const failingPort = await failing.start();
    try { assert.deepEqual(await callHelperEndpoint(failingPort, failing.issue({ role: 'lead', leadKey: 'k' }), 'hydra_get_helper', { job_id: 'aaaaaaaaaaaa' }), { ok: false, error: 'No such job.' }); }
    finally { await failing.close(); }
  } finally { await endpoint.close(); }
});

test('a caller that disconnects cancels its long call', async () => {
  let aborted = false;
  const endpoint = new HelperEndpoint((_caller, _tool, _args, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve('stopped'); }); }));
  const port = await endpoint.start();
  try {
    const controller = new AbortController();
    const call = callHelperEndpoint(port, endpoint.issue({ role: 'lead', leadKey: 'k' }), 'hydra_wait_for_helpers', { job_ids: ['aaaaaaaaaaaa'] }, controller.signal).catch(error => error);
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
  const windowA = new HelperEndpoint(async (caller, tool) => ({ window: 'A', tool, leadKey: caller.leadKey }));
  const windowB = new HelperEndpoint(async () => ({ window: 'B' }));
  const [portA, portB] = [await windowA.start(), await windowB.start()];
  try {
    const recordA = await writeWindowRecord(root, { port: portA, token: windowA.issue({ role: 'lead', leadKey: 'A' }), pid: process.pid, folders: [repoA] });
    await writeWindowRecord(root, { port: portB, token: windowB.issue({ role: 'lead', leadKey: 'B' }), pid: process.pid, folders: [repoB] });
    await writeFile(path.join(discoveryDirectory(root), 'dead.json'), JSON.stringify({ version: 1, port: 1, token: 't', pid: 999999, folders: [nested], writtenAt: '' }));
    assert.equal((await findWindowFor(root, nested))?.port, portA, 'a dead window with a deeper folder is ignored');
    assert.ok(!(await readdir(discoveryDirectory(root))).includes('dead.json'), 'dead records are cleaned up');
    assert.equal((await findWindowFor(root, repoB))?.port, portB);
    assert.equal(await findWindowFor(root, path.join(root, 'elsewhere')), undefined);

    const lead = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: nested, version: 'test' });
    const init = await lead.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) as { result: { protocolVersion: string; instructions: string } };
    assert.equal(init.result.protocolVersion, '2025-11-25'); assert.match(init.result.instructions, /hydra_start_helper/);
    const listed = await lead.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    assert.deepEqual(listed.result.tools.map(tool => tool.name), leadTools.map(tool => tool.name));
    const called = await lead.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hydra_list_helpers', arguments: {} } }) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(called.result.isError, undefined); assert.match(called.result.content[0]!.text, /"window": "A"/);
    assert.equal(await lead.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);

    const lost = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: path.join(root, 'elsewhere'), version: 'test' });
    const refused = await lost.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hydra_list_helpers', arguments: {} } }) as { result: { content: { text: string }[]; isError: boolean } };
    assert.equal(refused.result.isError, true); assert.match(refused.result.content[0]!.text, /Hydra isn't open for this folder/);
    const notSetUp = createBridge({ env: {}, cwd: repoA, version: 'test' });
    assert.match(JSON.stringify(await notSetUp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hydra_list_helpers' } })), /Connect Claude Code or Codex to Hydra/);

    const helper = createBridge({ env: { HYDRA_HELPER_PORT: String(portA), HYDRA_HELPER_TOKEN: windowA.issue({ role: 'helper', leadKey: 'A', jobId: 'bbbbbbbbbbbb' }) }, cwd: repoB, version: 'test' });
    const helperList = await helper.handle({ jsonrpc: '2.0', id: 6, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
    assert.deepEqual(helperList.result.tools.map(tool => tool.name), helperTools.map(tool => tool.name), 'a helper sees only helper actions, whatever folder it runs in');
    const leadOnly = await helper.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hydra_start_helper', arguments: {} } }) as { result: { isError: boolean } };
    assert.equal(leadOnly.result.isError, true);
    await removeWindowRecord(recordA);
    assert.equal(await findWindowFor(root, repoA), undefined);
  } finally { await windowA.close(); await windowB.close(); await rm(root, { recursive: true, force: true }); }
});
