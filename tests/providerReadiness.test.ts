import test from 'node:test'; import assert from 'node:assert/strict'; import { providerReadiness } from '../src/core/providerReadiness';
test('provider readiness is passive and keeps authorization unavailable until explicitly supplied', () => {
  assert.deepEqual(providerReadiness({ provider: 'codex', adapter: { version: '1.0', controls: ['model', 'effort'], advertised: { model: 'gpt', effort: 'medium' } }, selected: { model: 'gpt', effort: 'medium' }, taskTemplate: { goal: 'Verify one task', evidencePaths: ['evidence/log.txt'] } }), { provider: 'codex', adapter: 'ready', controls: 'ready', template: 'ready', authorization: 'missing', ready: false });
  assert.equal(providerReadiness({ provider: 'claude', adapter: { version: '1', controls: ['model'] } }).controls, 'unavailable');
  assert.equal(providerReadiness({ provider: 'claude', authorization: { operator: 'Nico', budget: 'one turn', approved: true } }).authorization, 'required');
  assert.throws(() => providerReadiness({ provider: 'codex', token: 'secret' }), /Invalid/);
  assert.equal(providerReadiness({ provider: 'codex', taskTemplate: { goal: 'x', evidencePaths: ['../x'] } }).template, 'missing');
  for (const path of ['C:/x', '\\\\server\\share', 'a/./b']) assert.equal(providerReadiness({ provider: 'codex', taskTemplate: { goal: 'x', evidencePaths: [path] } }).template, 'missing');
  assert.equal(providerReadiness({ provider: 'codex', adapter: { version: '1.0', controls: ['model', 'model', 'effort'], advertised: { model: 'gpt', effort: 'medium' } }, selected: { model: 'other', effort: 'medium' } }).controls, 'unavailable');
  assert.throws(() => providerReadiness({ provider: 'codex', selected: { model: 'gpt', effort: 'low', token: 'secret' } }), /Invalid/);
  assert.throws(() => providerReadiness({ provider: 'codex', adapter: { version: '1.0', controls: ['x'.repeat(81)] } }), /Invalid/);
});
