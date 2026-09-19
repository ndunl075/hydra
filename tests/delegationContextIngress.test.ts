import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path';
import { ingressDelegationContextRequest, viewDelegationContextRequest } from '../src/core/delegationContextIngress';
import { prepareContextRequest } from '../src/core/delegationContextRequests';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';

const binding = { parentId: '111111111111', runId: '222222222222', childKey: 'parser', writeScope: ['src/parser'], readScope: ['src/parser', 'src/contracts'] };
const source = { id: 'parser-api', path: 'src/contracts/parser.ts', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), reason: 'Need the current parser contract.' };
const input = (requestKey = 'c'.repeat(24)) => ({ version: 1, parentId: binding.parentId, runId: binding.runId, childKey: binding.childKey, requestKey, requested: [source] });
const observed = { 'parser-api': { path: source.path, revision: source.revision, sha256: source.sha256 } };
async function journal() { return new DelegationOrchestrationJournal(await mkdtemp(path.join(tmpdir(), 'hydra-context-ingress-'))); }

test('explicit ingress binds the child/run and returns only selected source references', async () => {
  const receipt = await ingressDelegationContextRequest(await journal(), prepareContextRequest(input(), binding), binding, observed);
  assert.equal(receipt.status, 'selected');
  if (receipt.status === 'selected') assert.deepEqual(receipt.selected, [{ id: source.id, path: source.path, revision: source.revision, sha256: source.sha256 }]);
  const copiedHistory = { ...input(), transcript: 'all parent and sibling history' };
  assert.deepEqual(await ingressDelegationContextRequest(await journal(), copiedHistory, binding, observed), { version: 1, status: 'refused', refusal: 'invalid-request' });
});
test('viewing is read-only and never asks a host to read sources', async () => {
  const store = await journal(); const request = prepareContextRequest(input(), binding);
  const receipt = viewDelegationContextRequest(request, binding);
  assert.equal(receipt.status, 'pending');
  assert.deepEqual(await store.load(binding.parentId, binding.runId), { events: [], contextRequests: [], results: [] });
});
test('stale and out-of-scope requests refuse without selecting context', async () => {
  const stale = await ingressDelegationContextRequest(await journal(), prepareContextRequest(input(), binding), binding, { 'parser-api': { ...observed['parser-api']!, revision: 'd'.repeat(40) } });
  assert.deepEqual(stale.status === 'refused' && stale.refusal, 'stale-source');
  const substituted = await ingressDelegationContextRequest(await journal(), prepareContextRequest(input(), binding), binding, { 'parser-api': { ...observed['parser-api']!, path: 'src/contracts/other.ts' } });
  assert.deepEqual(substituted.status === 'refused' && substituted.refusal, 'stale-source');
  const outside = { ...input(), requested: [{ ...source, path: 'src/private/token.ts' }] };
  const signedOutside = prepareContextRequest(outside, { ...binding, readScope: [...binding.readScope, 'src/private'] });
  const refused = await ingressDelegationContextRequest(await journal(), signedOutside, binding, observed);
  assert.deepEqual(refused, { version: 1, status: 'refused', refusal: 'out-of-scope' });
});
test('oversized delivery, exact duplicates, and restart replay remain bounded and deterministic', async () => {
  const store = await journal(); const oversized = { ...input(), requested: Array.from({ length: 16 }, (_, index) => ({ ...source, id: `source_${index}`, path: `src/parser/${index}.ts`, reason: 'x'.repeat(1000) })) };
  const size = await ingressDelegationContextRequest(store, prepareContextRequest(oversized, binding), binding, Object.fromEntries(oversized.requested.map(item => [item.id, { path: item.path, revision: item.revision, sha256: item.sha256 }])));
  assert.deepEqual(size.status === 'refused' && size.refusal, 'size-limit');
  const request = prepareContextRequest(input('d'.repeat(24)), binding);
  const first = await ingressDelegationContextRequest(store, request, binding, observed);
  const duplicate = await ingressDelegationContextRequest(store, request, binding, observed);
  assert.deepEqual(duplicate, first);
  assert.equal((await store.load(binding.parentId, binding.runId)).contextRequests.length, 2);
});
test('a persisted request can be resolved after restart without a duplicate journal receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-context-ingress-'));
  const first = new DelegationOrchestrationJournal(directory), request = prepareContextRequest(input(), binding);
  const accepted = await ingressDelegationContextRequest(first, request, binding, observed);
  const replay = await ingressDelegationContextRequest(new DelegationOrchestrationJournal(directory), request, binding, observed);
  assert.deepEqual(replay, accepted);
  assert.equal((await new DelegationOrchestrationJournal(directory).load(binding.parentId, binding.runId)).contextRequests.length, 1);
});

test('a changed request under the same key returns a bounded conflict refusal', async () => {
  const store = await journal();
  const original = prepareContextRequest(input(), binding);
  await ingressDelegationContextRequest(store, original, binding, observed);
  const changed = prepareContextRequest({ ...input(), requested: [{ ...source, reason: 'Different context need.' }] }, binding);
  const refused = await ingressDelegationContextRequest(store, changed, binding, observed);
  assert.equal(refused.status, 'refused');
  if (refused.status === 'refused') assert.equal(refused.refusal, 'conflict');
  assert.equal((await store.load(binding.parentId, binding.runId)).contextRequests.length, 1);
});
