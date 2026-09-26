import test from 'node:test';
import assert from 'node:assert/strict';
import { plannerArguments, plannerPrompt, plannerResultText } from '../src/core/planner';

test('the prompt asks for JSON only, 2-8 jobs, and the same rules as heads', () => {
  const prompt = plannerPrompt('Refactor checkout.');
  assert.match(prompt, /JSON only/);
  assert.match(prompt, /2 to 8 jobs/);
  assert.match(prompt, /complete brief/);
  assert.match(prompt, /narrow write scope/);
  assert.match(prompt, /Refactor checkout\.$/);
});

test('with active roles, the prompt lists them (ref, title, description) and allows an optional "role" per job', () => {
  const withoutRoles = plannerPrompt('Refactor checkout.');
  assert.doesNotMatch(withoutRoles, /"role"/);
  const prompt = plannerPrompt('Refactor checkout.', [{ ref: 'coding/builder', title: 'Builder', description: 'Builds the feature with tests.' }]);
  assert.match(prompt, /"role": "pack\/role" \(optional\)/);
  assert.match(prompt, /coding\/builder: Builder\. Builds the feature with tests\./);
});

test('the CLI arguments match the plan exactly for each provider', () => {
  assert.deepEqual(plannerArguments('claude', 'PROMPT'), ['-p', '--output-format', 'json', '--permission-mode', 'plan', 'PROMPT']);
  assert.deepEqual(plannerArguments('codex', 'PROMPT'), ['exec', '--json', '--sandbox', 'read-only', 'PROMPT']);
});

test('plannerResultText unwraps each provider\'s JSON envelope, and falls back to the raw text otherwise', () => {
  assert.equal(plannerResultText('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'the reply text' })), 'the reply text');
  assert.equal(plannerResultText('claude', 'not json at all'), 'not json at all', 'falls back when the envelope is not JSON');
  assert.equal(plannerResultText('claude', JSON.stringify({ type: 'result' })), JSON.stringify({ type: 'result' }), 'falls back when there is no result field');

  const codexStream = [
    JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking...' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first draft' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final reply' } }),
  ].join('\n');
  assert.equal(plannerResultText('codex', codexStream), 'final reply', 'the last agent message wins');
  assert.equal(plannerResultText('codex', 'no json lines here'), 'no json lines here');
});
