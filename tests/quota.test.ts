import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publicCodexQuota, readCodexQuota } from '../src/core/quota';
import { accountRpc, type AccountRpc } from '../src/core/accountSetup';

const fetchedAt = '2026-09-18T01:30:00.000Z';
const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1789700000 };
const bucket = { limitId: 'codex', limitName: null, primary, secondary: null };
const legacy = { rateLimits: bucket, rateLimitsByLimitId: null, ordinaryUsageAllowed: null };
async function fixture() { const base = path.resolve('.test-build/quota-fixtures'); await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'quota-')); }
async function clean(root: string) { assert.ok(root.startsWith(path.resolve('.test-build/quota-fixtures') + path.sep)); await rm(root, { recursive: true, force: true }); }

test('quota uses authoritative provider buckets, observed windows and unavailable optional fields', () => {
  const result = publicCodexQuota(legacy, fetchedAt);
  assert.equal(result.fetchedAt, fetchedAt); assert.equal(result.ordinaryUsageAllowed, undefined);
  assert.deepEqual(result.buckets[0]?.primary, { ...primary, remainingPercent: 75 }); assert.equal(result.buckets[0]?.secondary, undefined);
  const mapped = publicCodexQuota({ ...legacy, ordinaryUsageAllowed: false, rateLimitsByLimitId: { codex: { ...bucket, primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } }, model: { limitName: 'Model limit', primary: null, secondary: { usedPercent: 105, windowDurationMins: 10080, resetsAt: null } } } }, fetchedAt);
  assert.equal(mapped.buckets.length, 2); assert.equal(mapped.ordinaryUsageAllowed, false, 'Permission is never inferred from 100% remaining');
  assert.equal(mapped.buckets[0]?.primary?.remainingPercent, 100); assert.equal(mapped.buckets[0]?.primary?.resetsAt, undefined);
  assert.equal(mapped.buckets[1]?.id, 'model'); assert.equal(mapped.buckets[1]?.secondary?.remainingPercent, 0);
  assert.equal(publicCodexQuota({ ...legacy, rateLimitsByLimitId: {} }).buckets.length, 0, 'An authoritative empty map is unavailable, not a fallback to stale single-bucket data');
});

test('quota strips identities, billing balances, banners and reset credits without storing unknown as zero', () => {
  const result = publicCodexQuota({ ...legacy, accountId: 'private-account', rateLimitUpsell: { url: 'https://private.invalid', credential: 'private-token' }, rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'private-credit' }] }, rateLimits: { ...bucket, credits: { balance: 'private-balance' }, planType: 'private-plan', individualLimit: { private: true }, primary: null } }, fetchedAt);
  assert.ok(!JSON.stringify(result).includes('private')); assert.equal(result.buckets[0]?.primary, undefined);
  assert.equal(result.buckets[0]?.secondary, undefined);
});

test('quota refuses malformed measurements, bucket identities and unbounded responses', () => {
  for (const bad of [null, [], { ...legacy, ordinaryUsageAllowed: 1 }, { ...legacy, rateLimitsByLimitId: [] }, { ...legacy, rateLimitsByLimitId: { alias: bucket } }, { ...legacy, rateLimits: { ...bucket, limitName: 'bad\0label' } }, { ...legacy, rateLimits: { ...bucket, limitName: 'x'.repeat(201) } }]) assert.throws(() => publicCodexQuota(bad));
  for (const invalid of [{ usedPercent: -1 }, { usedPercent: Infinity }, { usedPercent: '25' }, { windowDurationMins: 0 }, { windowDurationMins: 1.5 }, { resetsAt: -1 }, { resetsAt: 1.5 }, { resetsAt: 8640000000001 }]) assert.throws(() => publicCodexQuota({ ...legacy, rateLimits: { ...bucket, primary: { ...primary, ...invalid } } }));
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`bucket-${index}`, { primary: null, secondary: null }]));
  assert.throws(() => publicCodexQuota({ ...legacy, rateLimitsByLimitId: many }), /Too many/);
  assert.throws(() => publicCodexQuota(legacy, 'invalid'), /observation/);
});

test('quota refresh is passive until invoked and closes after metadata-only requests', async () => {
  const calls: string[] = []; let closed = 0, connected = 0;
  const connect = (): AccountRpc => { connected++; return { async request(method) { calls.push(method); return method === 'initialize' ? { userAgent: 'codex/0.154.0 (fixture)' } : legacy; }, async close() { closed++; } }; };
  assert.equal(connected, 0);
  const result = await readCodexQuota(connect);
  assert.deepEqual(calls, ['initialize', 'account/rateLimits/read']); assert.equal(closed, 1); assert.equal(result.buckets[0]?.primary?.remainingPercent, 75);
  for (const userAgent of ['codex/0.154.1', 'codex/0.154.0-alpha.6.2', 'codex/0.154.0-custom', undefined]) {
    calls.length = 0;
    await assert.rejects(readCodexQuota(() => ({ async request(method) { calls.push(method); return { userAgent }; }, async close() {} })), /tested Codex/);
    assert.deepEqual(calls, ['initialize']);
  }
});

test('cancellation before/during initialization or quota read submits no extra requests and closes', async () => {
  const cancelled = new AbortController(); cancelled.abort(); let connected = false;
  await assert.rejects(readCodexQuota(() => { connected = true; throw new Error('must not connect'); }, cancelled.signal), /cancelled/); assert.equal(connected, false);
  for (const phase of ['initialize', 'account/rateLimits/read']) {
    const controller = new AbortController(), calls: string[] = []; let close = 0;
    const pending = readCodexQuota(() => ({ request(method) { calls.push(method); if (method === phase) return new Promise(() => {}); return Promise.resolve({ userAgent: 'codex/0.154.0 (fixture)' }); }, async close() { close++; } }), controller.signal);
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, /cancelled/); assert.ok(close >= 1);
    assert.deepEqual(calls, phase === 'initialize' ? ['initialize'] : ['initialize', 'account/rateLimits/read']);
  }
});

test('quota refresh has an overall deadline even if a transport never resolves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let closed = 0;
  const pending = readCodexQuota(() => ({ request() { return new Promise(() => {}); }, async close() { closed++; } }));
  t.mock.timers.tick(18000);
  await assert.rejects(pending, /timed out/); assert.ok(closed >= 1); t.mock.timers.reset();
});

test('cancelled quota refresh waits for owned transport termination before settling', async () => {
  const controller = new AbortController(); let closes = 0, settled = false;
  let finishClose!: () => void;
  const termination = new Promise<void>(resolve => { finishClose = resolve; });
  const pending = readCodexQuota(() => ({ request() { return new Promise(() => {}); }, async close() { if (++closes === 1) await termination; } }), controller.signal);
  const rejected = assert.rejects(pending, /cancelled/).finally(() => { settled = true; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1); assert.equal(settled, false, 'Caller must wait until owned termination is complete');
  finishClose(); await rejected; assert.equal(settled, true); assert.equal(closes, 1);
});

test('real JSONL quota channel rejects model, login and billing mutations and never logs private payloads', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'app-server'), `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync('methods.jsonl',line+'\\n');if(message.id)process.stdout.write(JSON.stringify({id:message.id,result:message.method==='initialize'?{userAgent:'codex/0.154.0 (fixture)'}:${JSON.stringify({ ...legacy, accountId: 'private-id' })}})+'\\n');});`);
    let failed = false;
    const rpc = accountRpc(process.execPath, root, () => {}, () => { failed = true; }, 'quota');
    for (const method of ['account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimitResetCredit/consume', 'account/sendAddCreditsNudgeEmail', 'model/list', 'thread/start', 'thread/resume', 'turn/start']) await assert.rejects(rpc.request(method, {}), /Unsupported account method/);
    const result = await readCodexQuota(() => rpc);
    assert.equal(failed, false); assert.ok(!JSON.stringify(result).includes('private-id'));
    const calls = (await readFile(path.join(root, 'methods.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(item => item.method), ['initialize', 'initialized', 'account/rateLimits/read']);
    assert.ok(!calls.some(item => /^thread|^turn|login|consume/.test(item.method)));
    assert.ok(!(await readFile(path.join(root, 'methods.jsonl'), 'utf8')).includes('private-id'));
  } finally { await clean(root); }
});
