import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from '../src/core/delegationContext';
import { DelegationEvaluationImport, readDelegationEvaluationImportBundle } from '../src/core/delegationEvaluationImport';

const corpus = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/corpus-v1.json', 'utf8'));
const descriptors = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/paired-runs-v1.json', 'utf8'));
const artifactBody = '{"ok":true}\n';
const artifactSha = digest(artifactBody);
const writeArtifact = async (bundles: string) => { await mkdir(path.join(bundles, 'evidence')); await writeFile(path.join(bundles, 'evidence', 'summary.json'), artifactBody); };
const seal = (value: any) => { const { sha256: _ignored, ...unsigned } = value; value.sha256 = digest(JSON.stringify(unsigned)); return value; };
const bundle = (run = '333333333333', id = '111111111111111111111111') => ({ version: 1, delegatedRunId: run, corpus: { id: 'delegation-v1', sha256: corpus().sha256 }, case: { id: 'localized-fix', sha256: corpus().cases[0].caseSha256, baseCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' }, observation: seal({ version: 1, id, pairId: 'aaaaaaaaaaaaaaaaaaaaaaaa', runId: '333333333333333333333333', descriptor: descriptors().auto, acceptance: 'passed', quality: { status: 'passed', score: 92 }, elapsedTime: { status: 'unavailable' }, reportedUsage: { coverage: 'partial', tokens: 100 }, regressions: { status: 'passed', count: 0 }, integrationConflicts: { status: 'unavailable' }, manualRework: { status: 'unavailable' }, artifacts: [{ label: 'sealed-summary', path: 'evidence/summary.json', sha256: artifactSha }] }) });

test('imports an exact sealed local observation, persists the run binding, and exports references only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-evaluation-import-'));
  try {
    const bundles = path.join(directory, 'bundles'), storage = path.join(directory, 'storage');
    await mkdir(bundles); await writeArtifact(bundles);
    await writeFile(path.join(bundles, 'observation.json'), JSON.stringify(bundle()));
    const importer = new DelegationEvaluationImport(storage, bundles);
    const first = await importer.import('observation.json', corpus());
    assert.deepEqual(first, { delegatedRunId: '333333333333', observationId: '111111111111111111111111', observationSha256: (bundle().observation as any).sha256 });
    assert.deepEqual(await importer.import('observation.json', corpus()), first);
    assert.deepEqual(await new DelegationEvaluationImport(storage, bundles).exportEvidence('333333333333', corpus()), { availability: 'available', references: [{ id: first.observationId, sha256: first.observationSha256 }] });
    assert.deepEqual(await importer.exportEvidence('444444444444', corpus()), { availability: 'unavailable', references: [] });
    await writeFile(path.join(bundles, 'evidence', 'summary.json'), '{"ok":false}\n');
    await assert.rejects(importer.import('observation.json', corpus()), /artifact hash/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses stale corpus/case/provider/model/effort or changed run pair bindings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-evaluation-import-'));
  try {
    const bundles = path.join(directory, 'bundles'), storage = path.join(directory, 'storage'); await mkdir(bundles); await writeArtifact(bundles);
    const stale = bundle(); stale.case.model = 'gpt-5.5'; await writeFile(path.join(bundles, 'stale.json'), JSON.stringify(stale));
    const importer = new DelegationEvaluationImport(storage, bundles);
    await assert.rejects(importer.import('stale.json', corpus()), /exactly match/);
    await writeFile(path.join(bundles, 'first.json'), JSON.stringify(bundle())); await importer.import('first.json', corpus());
    await writeFile(path.join(bundles, 'conflict.json'), JSON.stringify(bundle('333333333333', '222222222222222222222222')));
    await assert.rejects(importer.import('conflict.json', corpus()), /conflicts/);
    const conflictingPair = bundle('444444444444', '222222222222222222222222');
    (conflictingPair.observation as any).runId = '444444444444444444444444'; seal(conflictingPair.observation);
    await writeFile(path.join(bundles, 'conflicting-pair.json'), JSON.stringify(conflictingPair));
    await assert.rejects(importer.import('conflicting-pair.json', corpus()), /conflicting mode evidence/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses traversal, symlink, and oversized bundles before parsing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-evaluation-import-'));
  try {
    const bundles = path.join(directory, 'bundles'); await mkdir(bundles);
    await assert.rejects(readDelegationEvaluationImportBundle(bundles, '../outside.json'), /outside/);
    await writeFile(path.join(bundles, 'large.json'), Buffer.alloc(512 * 1024 + 1));
    await assert.rejects(readDelegationEvaluationImportBundle(bundles, 'large.json'), /oversized/);
    await writeFile(path.join(directory, 'outside.json'), JSON.stringify(bundle()));
    try { await symlink(path.join(directory, 'outside.json'), path.join(bundles, 'linked.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation is unavailable in this Windows test environment'); return; } throw error; }
    await assert.rejects(readDelegationEvaluationImportBundle(bundles, 'linked.json'), /unsafe/);
    try { await symlink(directory, path.join(bundles, 'linked-dir'), 'junction'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    if (await import('node:fs/promises').then(fs => fs.lstat(path.join(bundles, 'linked-dir')).then(() => true, () => false))) {
      await assert.rejects(readDelegationEvaluationImportBundle(bundles, 'linked-dir/outside.json'), /unsafe/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
