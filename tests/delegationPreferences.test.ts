import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelegationMode, parseDelegationPreferences, requireDelegationMode } from '../src/core/delegationPreferences';
import { parseMessage } from '../src/core/model';

test('delegation preferences stay conservative and bounded before dispatch exists', () => {
  assert.deepEqual(parseDelegationPreferences(undefined), { mode: 'solo', maxChildren: 2, status: 'preparation' });
  assert.deepEqual(parseDelegationPreferences({ mode: 'auto', maxChildren: 9 }), { mode: 'auto', maxChildren: 8, status: 'preparation' });
  assert.deepEqual(parseDelegationPreferences({ mode: 'unexpected', maxChildren: 0 }), { mode: 'solo', maxChildren: 1, status: 'preparation' });
  assert.equal(parseDelegationMode('unexpected'), 'solo');
  assert.throws(() => requireDelegationMode('unexpected'), /Invalid delegation mode/);
});

test('the webview accepts only explicit delegation preferences', () => {
  assert.deepEqual(parseMessage({ type: 'setDelegationMode', mode: 'auto' }), { type: 'setDelegationMode', mode: 'auto' });
  assert.throws(() => parseMessage({ type: 'setDelegationMode', mode: 'fan-out' }), /Invalid delegation mode/);
});
