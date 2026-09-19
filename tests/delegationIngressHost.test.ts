import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DelegationIngressHost } from '../src/core/delegationIngressHost';
import { DelegationOrchestrationJournal } from '../src/core/delegationOrchestrationJournal';
import { prepareContextRequest } from '../src/core/delegationContextRequests';
import { digest } from '../src/core/delegationContext';
import { git } from '../src/core/git';
import type { Task } from '../src/core/model';

const parentId = '111111111111', runId = '222222222222', childId = '333333333333';
const content = 'export interface Api {}\n';
async function fixture(fileContent = content, assertSourceReady: () => Promise<void> = async () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-ingress-host-'));
  const repository = path.join(directory, 'repo');
  await mkdir(path.join(repository, 'src', 'contracts'), { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  const file = path.join(repository, 'src', 'contracts', 'api.ts');
  await writeFile(file, fileContent);
  await git(repository, ['add', '--', 'src/contracts/api.ts']);
  await git(repository, ['-c', 'user.name=Hydra Test', '-c', 'user.email=hydra@example.invalid', 'commit', '-m', 'source']);
  const base = (await git(repository, ['rev-parse', 'HEAD'])).trim();
  const source = { id: 'contract', path: 'src/contracts/api.ts', revision: base, content: 'export interface Api {}', reason: 'Required API excerpt', sha256: digest('export interface Api {}') };
  const child: Task = { id: childId, title: 'Child', prompt: 'child', repository, worktree: repository, branch: 'main', baseCommit: base, integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', delegation: { parentId, runId, childKey: 'child', dispatchKey: 'd'.repeat(24), dependencies: [] } };
  const tasks = [{ ...child, id: parentId, delegation: undefined }, child];
  const decisions = { load: async () => ({ usedKeys: ['child'], decisions: [{ manifests: [{ child: { parentId, runId, key: 'child', baseCommit: base, writeScope: ['src'], dependencies: [] }, instructions: [source], interfaces: [], evidence: [] }] }] }) };
  const journal = new DelegationOrchestrationJournal(path.join(directory, 'journal'));
  const host = new DelegationIngressHost(() => tasks, decisions as never, { load: async () => [] } as never, journal, assertSourceReady);
  const request = (requestKey = 'c'.repeat(24)) => prepareContextRequest({ version: 1, parentId, runId, childKey: 'child', requestKey, requested: [{ id: source.id, path: source.path, revision: source.revision, sha256: source.sha256, reason: 'Need it.' }] }, { parentId, runId, childKey: 'child', writeScope: ['src'], readScope: [source.path] });
  return { directory, file, source, host, journal, request };
}

test('host selects only a real unchanged Git excerpt and rejects caller identity spoofing', async () => {
  const value = await fixture();
  try {
    const request = value.request();
    const receipt = await value.host.supplyContext(childId, request);
    assert.equal(receipt.status, 'selected');
    assert.deepEqual(await value.host.supplyContext(childId, request), receipt);
    assert.deepEqual(await value.host.supplyContext(childId, { ...request, parentId: '0'.repeat(12), requestKey: 'e'.repeat(24) }), { version: 1, status: 'refused', refusal: 'invalid-request' });
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('child request recording creates a visible durable inbox receipt without reading or supplying a source', async () => {
  let sourceChecks = 0;
  const value = await fixture(content, async () => { sourceChecks++; });
  try {
    const request = value.request();
    assert.deepEqual(await value.host.recordContextRequest(childId, request), request);
    assert.deepEqual(await value.host.recordContextRequest(childId, request), request);
    assert.deepEqual((await new DelegationOrchestrationJournal(path.join(value.directory, 'journal')).load(parentId, runId)).contextRequests, [request]);
    assert.equal(sourceChecks, 0);
    assert.equal((await value.journal.load(parentId, runId)).contextOutcomes, undefined);
    await assert.rejects(value.host.recordContextRequest(childId, { ...request, parentId: '0'.repeat(12) }), /different delegated child|changed/);
    const stale = prepareContextRequest({ version: 1, parentId, runId, childKey: 'child', requestKey: 'e'.repeat(24), requested: [{ id: value.source.id, path: value.source.path, revision: value.source.revision, sha256: 'f'.repeat(64), reason: 'Need it.' }] }, { parentId, runId, childKey: 'child', writeScope: ['src'], readScope: [value.source.path] });
    await assert.rejects(value.host.recordContextRequest(childId, stale), /immutable source/);
    assert.equal(sourceChecks, 0);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('host refuses a changed, missing, or substituted current source', async () => {
  for (const change of ['changed', 'missing', 'substituted'] as const) {
    const value = await fixture();
    try {
      if (change === 'changed') await writeFile(value.file, `${content}// changed\n`);
      if (change === 'missing') await rm(value.file);
      if (change === 'substituted') await writeFile(value.file, 'export interface Other {}\n');
      const receipt = await value.host.supplyContext(childId, value.request());
      assert.deepEqual(receipt.status === 'refused' && receipt.refusal, 'stale-source', change);
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  }
});

test('host refuses a source path redirected through a symlink', async t => {
  const value = await fixture();
  try {
    const target = path.join(value.directory, 'target.ts');
    await writeFile(target, await readFile(value.file));
    await rm(value.file);
    try { await symlink(target, value.file); } catch { t.skip('symlinks unavailable'); return; }
    const receipt = await value.host.supplyContext(childId, value.request());
    assert.deepEqual(receipt.status === 'refused' && receipt.refusal, 'stale-source');
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('host rejects a saved excerpt that is absent from its recorded Git blob', async () => {
  const value = await fixture();
  try {
    value.source.content = 'export interface Forged {}';
    value.source.sha256 = digest(value.source.content);
    const receipt = await value.host.supplyContext(childId, value.request());
    assert.deepEqual(receipt.status === 'refused' && receipt.refusal, 'stale-source');
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('host refuses a source blob above the observation size bound', async () => {
  const value = await fixture(content + 'x'.repeat(1024 * 1024));
  try {
    const receipt = await value.host.supplyContext(childId, value.request());
    assert.deepEqual(receipt.status === 'refused' && receipt.refusal, 'stale-source');
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('a source-readiness failure before durable append leaves no context receipt', async () => {
  let checks = 0;
  const value = await fixture(content, async () => { if (++checks === 2) throw new Error('Unsaved child editor buffer.'); });
  try {
    await assert.rejects(value.host.supplyContext(childId, value.request()), /Unsaved child editor buffer/);
    assert.equal(checks, 2);
    assert.deepEqual((await value.journal.load(parentId, runId)).contextRequests, []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});
