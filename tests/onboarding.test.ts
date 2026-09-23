import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnboarding, advanceOnboarding, shouldOpenOnboarding } from '../src/core/onboarding';

test('onboarding resumes interrupted steps, records optional skips, and completes only at the last step', () => {
  let state = readOnboarding(undefined);
  assert.equal(state.step, 'welcome');
  state = advanceOnboarding(state, false);
  assert.equal(state.step, 'import');
  state = advanceOnboarding(state, true);
  assert.deepEqual(state.skipped, ['import']);
  assert.deepEqual(readOnboarding(JSON.parse(JSON.stringify(state))), state);
  state = advanceOnboarding(state, false);
  assert.equal(state.step, 'accounts'); assert.equal(state.completed, false);
  state = advanceOnboarding(state, true);
  assert.equal(state.step, 'accounts'); assert.equal(state.completed, true);
  assert.deepEqual(state.skipped, ['import', 'accounts']);
});
test('onboarding migrates the retired project step onto accounts without losing completion', () => {
  const migrated = readOnboarding({ version: 1, step: 'project', completed: true, skipped: ['appearance', 'project'] });
  assert.equal(migrated.step, 'accounts');
  assert.equal(migrated.completed, true);
  assert.deepEqual(migrated.skipped, ['appearance', 'accounts']);
});
test('onboarding rejects corrupt persisted state and never auto-opens in tests, development, remote, untrusted or handoff windows', () => {
  for (const value of [null, {}, {version:1, step:'import', completed:false, skipped:['invalid']}, {version:2, step:'project', completed:true, skipped:[]}]) assert.equal(readOnboarding(value).step, 'welcome');
  const allowed = { desktop:true, trusted:true, development:false, handoff:false, completed:false };
  assert.equal(shouldOpenOnboarding(allowed), true);
  for (const override of [{desktop:false}, {trusted:false}, {development:true}, {handoff:true}, {completed:true}]) assert.equal(shouldOpenOnboarding({...allowed,...override}), false);
});
