import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/core/model';

test('focused delegation actions accept only bounded task and durable receipt identifiers', () => {
  const id = '1'.repeat(12), requestKey = '2'.repeat(24);
  assert.deepEqual(parseMessage({ type: 'supplyDelegationContext', id, requestKey }), { type: 'supplyDelegationContext', id, requestKey });
  assert.deepEqual(parseMessage({ type: 'reviewDelegationResult', id, decision: 'approved', reason: 'Reviewed the child diff and evidence.' }), { type: 'reviewDelegationResult', id, decision: 'approved', reason: 'Reviewed the child diff and evidence.' });
  assert.throws(() => parseMessage({ type: 'supplyDelegationContext', id, requestKey: 'bad' }), /context request/);
  assert.throws(() => parseMessage({ type: 'reviewDelegationResult', id, decision: 'pending', reason: 'no' }), /decision/);
});
