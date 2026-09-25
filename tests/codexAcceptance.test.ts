import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CodexAccountFlow, type AccountRpc } from '../src/core/accountSetup';
import { publicCodexQuota, readCodexQuota } from '../src/core/quota';

const script = path.resolve('scripts/codex-acceptance.mjs');

test('Codex acceptance fixture records only documented account and quota order, redacted evidence, owned cancellation and unavailable quota', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydra-codex-acceptance-'));
  const output = path.join(root, 'fixture-evidence.json');
  try {
    const result = spawnSync(process.execPath, [script, '--fixture', '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(evidence.mode, 'fixture');
    assert.equal(evidence.liveAcceptance, 'pending-human-operated-run');
    assert.deepEqual(evidence.rpc.accountRefresh, ['initialize', 'initialized', 'account/read']);
    assert.deepEqual(evidence.rpc.accountLoginCancel, ['initialize', 'initialized', 'account/login/start', 'account/login/cancel']);
    assert.deepEqual(evidence.rpc.quotaRefresh, ['initialize', 'initialized', 'account/rateLimits/read']);
    assert.deepEqual(Object.keys(evidence.rpc), ['accountRefresh', 'accountLoginCancel', 'quotaRefresh'], 'No model-turn sequence is claimed');
    assert.deepEqual(evidence.assertions.cancellation, { ownedChannelClosed: true, extraRequestsAfterCancellation: 0 });
    assert.deepEqual(evidence.assertions.quota, { status: 'unavailable' });
    assert.equal(evidence.assertions.identityAndResetTokensAbsent, true);
    const rendered = JSON.stringify(evidence);
    for (const privateValue of ['fixture-account-id', 'fixture-reset-token', 'private@example.invalid', 'api-key']) assert.equal(rendered.includes(privateValue), false);
    assert.ok(evidence.limitations.some((item: string) => item.includes('did not open a browser')));
    assert.ok(evidence.limitations.some((item: string) => item.includes('did not submit a provider turn')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex acceptance runner requires the explicit fixture opt-in and refuses overwrite', async () => {
  const noOptIn = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(noOptIn.status, 1); assert.match(noOptIn.stderr, /--fixture/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydra-codex-acceptance-'));
  const output = path.join(root, 'fixture-evidence.json');
  try {
    assert.equal(spawnSync(process.execPath, [script, '--fixture', '--output', output], { encoding: 'utf8' }).status, 0);
    const repeat = spawnSync(process.execPath, [script, '--fixture', '--output', output], { encoding: 'utf8' });
    assert.equal(repeat.status, 1); assert.match(repeat.stderr, /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the existing account and quota fixtures send no undocumented methods, redact provider fields, and close cancellation ownership', async () => {
  const accountCalls: string[] = []; let accountClosed = 0;
  const flow = new CodexAccountFlow((): AccountRpc => ({
    async request(method) {
      accountCalls.push(method);
      if (method === 'initialize') return {};
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'private-login-id', authUrl: 'https://auth.openai.com/authorize?state=private-state' };
      return { status: 'canceled' };
    },
    async close() { accountClosed++; }
  }), () => {}, async () => true);
  await flow.login(); await flow.cancel();
  assert.deepEqual(accountCalls, ['initialize', 'account/login/start', 'account/login/cancel']);
  assert.equal(accountClosed, 1, 'AccountRpc cancellation closes the owned channel exactly once.');
  assert.equal(accountCalls.some(method => /^(?:thread|turn|model|account\/rateLimit)/.test(method)), false);

  const quotaCalls: string[] = [];
  const quota = await readCodexQuota(() => ({
    async request(method) {
      quotaCalls.push(method);
      return method === 'initialize' ? { userAgent: 'codex/0.154.0 (fixture)' } : {
        accountId: 'private-account-id', rateLimitResetCredits: { token: 'private-reset-token' }, ordinaryUsageAllowed: null,
        rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: null }, rateLimitsByLimitId: {}
      };
    },
    async close() {}
  }));
  assert.deepEqual(quotaCalls, ['initialize', 'account/rateLimits/read']);
  assert.deepEqual(quota, { fetchedAt: quota.fetchedAt, buckets: [] }, 'An authoritative empty quota map stays unavailable, not zero.');
  assert.equal(JSON.stringify(quota).includes('private'), false);

  const controller = new AbortController(); let closed = 0; const cancelledCalls: string[] = [];
  const pending = readCodexQuota(() => ({
    request(method) { cancelledCalls.push(method); return new Promise(() => {}); },
    async close() { closed++; }
  }), controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(cancelledCalls, ['initialize']); assert.equal(closed, 1);
  assert.deepEqual(publicCodexQuota({ rateLimits: { limitId: 'codex', limitName: null, primary: null, secondary: null }, rateLimitsByLimitId: {} }).buckets, []);
});
