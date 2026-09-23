import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestContextUsage, parseContextUsage, validContextUsage } from '../src/core/contextUsage';
import { parseMessage } from '../src/core/model';

test('context usage derives its percentage from the token counts and rejects anything malformed', () => {
  // The provider's own percentage is ignored, so a fraction-vs-percent mismatch cannot skew the ring.
  assert.deepEqual(parseContextUsage({ totalTokens: 50000, maxTokens: 200000, percentage: 0.25 }), { totalTokens: 50000, maxTokens: 200000, percentage: 25 });
  assert.equal(parseContextUsage({ totalTokens: 1, maxTokens: 3 })!.percentage, 33.3);
  assert.equal(parseContextUsage({ totalTokens: 300000, maxTokens: 200000 })!.percentage, 100);
  for (const value of [null, undefined, [], 'full', { totalTokens: 1 }, { totalTokens: -1, maxTokens: 10 }, { totalTokens: 1.5, maxTokens: 10 }, { totalTokens: 1, maxTokens: 0 }, { totalTokens: 'lots', maxTokens: 10 }]) {
    assert.equal(parseContextUsage(value), undefined, JSON.stringify(value));
  }
  // A stored snapshot must carry the percentage its own counts imply.
  assert.equal(validContextUsage({ totalTokens: 50000, maxTokens: 200000, percentage: 25 }), true);
  assert.equal(validContextUsage({ totalTokens: 50000, maxTokens: 200000, percentage: 90 }), false);
});

test('the ring shows the most recent turn that reported usage', () => {
  const a = { totalTokens: 1, maxTokens: 10, percentage: 10 }, b = { totalTokens: 5, maxTokens: 10, percentage: 50 };
  assert.equal(latestContextUsage([]), undefined);
  assert.deepEqual(latestContextUsage([{ contextUsage: a }, { contextUsage: b }, {}]), b);
});

test('provider and model are submitted together, validated, and never carry an unknown provider', () => {
  const id = '111111111111';
  assert.deepEqual(parseMessage({ type: 'saveProviderSelection', id, provider: 'codex', selection: null }), { type: 'saveProviderSelection', id, provider: 'codex', selection: null });
  assert.deepEqual(parseMessage({ type: 'saveProviderSelection', id, provider: 'claude', selection: { model: 'opus', effort: 'medium' } }), { type: 'saveProviderSelection', id, provider: 'claude', selection: { model: 'opus', effort: 'medium' } });
  assert.throws(() => parseMessage({ type: 'saveProviderSelection', id, provider: 'gemini', selection: null }), /Unknown provider/);
  assert.throws(() => parseMessage({ type: 'saveProviderSelection', id, provider: 'claude', selection: { model: 'opus', effort: '' } }), /Invalid model or effort/);
  assert.throws(() => parseMessage({ type: 'saveProviderSelection', id: 'nope', provider: 'claude', selection: null }), /Invalid task ID/);
});
