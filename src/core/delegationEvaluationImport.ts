import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { replaceAtomic } from './atomicFile';
import { parseDelegationEvaluationCorpus, type DelegationEvaluationCorpus } from './delegationEvaluationCorpus';
import { DelegationEvaluationLedger, parseDelegationEvaluationObservation, projectDelegationEvaluationLedger, type DelegationEvaluationObservation } from './delegationEvaluationLedger';
import type { DelegationRunArchiveEvidenceReference } from './delegationRunExport';

export const maxDelegationEvaluationImportBundleBytes = 512 * 1024;
export interface DelegationEvaluationImportBundle {
  version: 1;
  delegatedRunId: string;
  corpus: { id: string; sha256: string };
  case: { id: string; sha256: string; baseCommit: string; provider: 'claude' | 'codex'; model: string; effort: string };
  observation: unknown;
}
interface DelegationEvaluationBinding { delegatedRunId: string; observationId: string; observationSha256: string; corpusSha256?: string; }

const runId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) throw new Error('Invalid delegated evaluation run binding.');
  return value;
};
const observationId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new Error('Invalid delegated evaluation observation binding.');
  return value;
};
const sha = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid delegated evaluation ${label}.`);
  return value;
};
const exact = (value: Record<string, unknown>, keys: string[], label: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`Invalid delegated evaluation import ${label}.`);
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid delegated evaluation import ${label}.`);
  return value as Record<string, unknown>;
};

/** Reads only a bounded regular file beneath the selected directory, rejecting redirected parents. */
async function readSelectedFile(bundleDirectory: string, relativePath: string): Promise<Buffer> {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || path.isAbsolute(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Evaluation import bundle path is outside its selected directory.');
  const root = path.resolve(bundleDirectory), file = path.resolve(root, relativePath);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Evaluation import bundle path is outside its selected directory.');
  try {
    let directory = root;
    for (const part of relativePath.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      const parent = await lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Evaluation import bundle storage is unsafe or oversized.');
    }
    const actualRoot = await realpath(root), actualFile = await realpath(file);
    if (!actualFile.startsWith(`${actualRoot}${path.sep}`)) throw new Error('Evaluation import bundle storage is unsafe or oversized.');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation import bundle storage is unsafe or oversized.');
    const bytes = await readFile(file);
    if (bytes.length > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation import bundle storage is unsafe or oversized.');
    return bytes;
  } catch (error) {
    if (error instanceof Error && /unsafe or oversized/.test(error.message)) throw error;
    throw new Error('Evaluation import bundle could not be read safely.');
  }
}

/** Reads one user-selected local bundle below bundleDirectory; this is not a general file reader. */
export async function readDelegationEvaluationImportBundle(bundleDirectory: string, relativePath: string): Promise<DelegationEvaluationImportBundle> {
  const bytes = await readSelectedFile(bundleDirectory, relativePath);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid delegated evaluation import bundle JSON.'); }
  const input = object(value, 'bundle'); exact(input, ['version', 'delegatedRunId', 'corpus', 'case', 'observation'], 'bundle fields');
  const corpus = object(input.corpus, 'corpus'); exact(corpus, ['id', 'sha256'], 'corpus fields');
  const baseline = object(input.case, 'case'); exact(baseline, ['id', 'sha256', 'baseCommit', 'provider', 'model', 'effort'], 'case fields');
  if (input.version !== 1 || typeof corpus.id !== 'string' || typeof baseline.id !== 'string' || typeof baseline.baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(baseline.baseCommit) || (baseline.provider !== 'claude' && baseline.provider !== 'codex') || typeof baseline.model !== 'string' || typeof baseline.effort !== 'string') throw new Error('Invalid delegated evaluation import bundle.');
  return { version: 1, delegatedRunId: runId(input.delegatedRunId), corpus: { id: corpus.id, sha256: sha(corpus.sha256, 'corpus SHA-256') }, case: { id: baseline.id, sha256: sha(baseline.sha256, 'case SHA-256'), baseCommit: baseline.baseCommit, provider: baseline.provider, model: baseline.model, effort: baseline.effort }, observation: input.observation };
}

function assertExactBundleBaseline(bundle: DelegationEvaluationImportBundle, corpus: DelegationEvaluationCorpus, observation: DelegationEvaluationObservation): void {
  const baseline = corpus.cases.find(item => item.id === bundle.case.id);
  if (!baseline || bundle.corpus.id !== corpus.id || bundle.corpus.sha256 !== corpus.sha256 || bundle.case.sha256 !== baseline.caseSha256 || bundle.case.baseCommit !== baseline.baseCommit || bundle.case.provider !== baseline.provider || bundle.case.model !== baseline.modelSelection.model || bundle.case.effort !== baseline.modelSelection.effort || observation.descriptor.corpusId !== corpus.id || observation.descriptor.corpusSha256 !== corpus.sha256 || observation.descriptor.caseId !== baseline.id || observation.descriptor.caseSha256 !== baseline.caseSha256) throw new Error('Evaluation import does not exactly match its immutable corpus case, mode, base, provider, model, effort, or artifacts.');
}

/** Durable local binding store. It saves references only, never prompts, transcripts, credentials, or artifact contents. */
export class DelegationEvaluationImport {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly storageDirectory: string, private readonly bundleDirectory: string, private readonly ledger = new DelegationEvaluationLedger(storageDirectory)) {}
  private file() { return path.join(this.storageDirectory, 'delegation-evaluation-import-bindings.json'); }
  private lock() { return `${this.file()}.lock`; }
  private corpusFile(corpusSha256: string) { return path.join(this.storageDirectory, `delegation-evaluation-corpus-${sha(corpusSha256, 'corpus SHA-256')}.json`); }
  private async savedCorpus(corpusSha256: string): Promise<DelegationEvaluationCorpus | undefined> {
    const filename = this.corpusFile(corpusSha256);
    let info;
    try { info = await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation corpus storage is unsafe or oversized.');
    const bytes = await readFile(filename);
    if (bytes.length > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation corpus storage is unsafe or oversized.');
    const corpus = parseDelegationEvaluationCorpus(JSON.parse(bytes.toString('utf8')));
    if (corpus.sha256 !== corpusSha256) throw new Error('Evaluation corpus binding changed.');
    return corpus;
  }
  private async retainCorpus(corpus: DelegationEvaluationCorpus): Promise<void> {
    const existing = await this.savedCorpus(corpus.sha256);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(corpus)) throw new Error('Evaluation corpus binding changed.'); return; }
    const bytes = Buffer.from(JSON.stringify(corpus), 'utf8');
    if (bytes.length > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation corpus storage is oversized.');
    const temporary = path.join(this.storageDirectory, `delegation-evaluation-corpus-${randomUUID()}.tmp`);
    try { const handle = await open(temporary, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await replaceAtomic(temporary, this.corpusFile(corpus.sha256)); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  private async loadBindings(): Promise<DelegationEvaluationBinding[]> {
    let bytes: Buffer;
    try { const info = await lstat(this.file()); if (!info.isFile() || info.isSymbolicLink() || info.size > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation import binding storage is unsafe.'); bytes = await readFile(this.file()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (bytes.length > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation import binding storage is unsafe.');
    const value = object(JSON.parse(bytes.toString('utf8')), 'binding store'); exact(value, ['version', 'bindings'], 'binding store fields');
    if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 10_000) throw new Error('Invalid evaluation import binding storage.');
    const bindings = value.bindings.map(item => { const binding = object(item, 'binding'); exact(binding, binding.corpusSha256 === undefined ? ['delegatedRunId', 'observationId', 'observationSha256'] : ['delegatedRunId', 'observationId', 'observationSha256', 'corpusSha256'], 'binding fields'); return { delegatedRunId: runId(binding.delegatedRunId), observationId: observationId(binding.observationId), observationSha256: sha(binding.observationSha256, 'observation SHA-256'), ...(binding.corpusSha256 === undefined ? {} : { corpusSha256: sha(binding.corpusSha256, 'corpus SHA-256') }) }; });
    if (new Set(bindings.map(item => item.delegatedRunId)).size !== bindings.length || new Set(bindings.map(item => item.observationId)).size !== bindings.length) throw new Error('Conflicting evaluation import bindings.');
    return bindings;
  }
  private async saveBindings(bindings: DelegationEvaluationBinding[]): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ version: 1, bindings }, null, 2), 'utf8');
    if (bytes.length > maxDelegationEvaluationImportBundleBytes) throw new Error('Evaluation import binding storage is oversized.');
    const temporary = path.join(this.storageDirectory, `delegation-evaluation-import-${randomUUID()}.tmp`);
    try { const handle = await open(temporary, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await replaceAtomic(temporary, this.file()); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async import(relativeBundlePath: string, corpusValue: unknown): Promise<DelegationEvaluationBinding> {
    const operation = this.queue.then(async () => {
      const corpus = parseDelegationEvaluationCorpus(corpusValue), bundle = await readDelegationEvaluationImportBundle(this.bundleDirectory, relativeBundlePath);
      const observation = parseDelegationEvaluationObservation(bundle.observation, corpus); assertExactBundleBaseline(bundle, corpus, observation);
      let artifactBytes = 0;
      for (const artifact of observation.artifacts) {
        const bytes = await readSelectedFile(this.bundleDirectory, artifact.path);
        artifactBytes += bytes.length;
        if (artifactBytes > 2 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Evaluation import artifact hash is stale or exceeds the total size bound.');
      }
      await mkdir(this.storageDirectory, { recursive: true });
      const token = randomUUID(), lock = this.lock();
      await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Evaluation import has another writer or a retained lock.'); throw error; });
      try {
        const bindings = await this.loadBindings(), candidate = { delegatedRunId: bundle.delegatedRunId, observationId: observation.id, observationSha256: observation.sha256, corpusSha256: corpus.sha256 };
        const existing = bindings.find(item => item.delegatedRunId === candidate.delegatedRunId || item.observationId === candidate.observationId);
        if (existing) {
          if (existing.delegatedRunId !== candidate.delegatedRunId || existing.observationId !== candidate.observationId || existing.observationSha256 !== candidate.observationSha256 || (existing.corpusSha256 && existing.corpusSha256 !== candidate.corpusSha256)) throw new Error('Evaluation import binding conflicts with immutable prior evidence.');
          const retained = (await this.ledger.load(corpus)).some(item => item.id === candidate.observationId && item.sha256 === candidate.observationSha256);
          if (!retained) throw new Error('Evaluation import binding has no matching retained observation.');
          await this.retainCorpus(corpus);
          if (!existing.corpusSha256) await this.saveBindings(bindings.map(item => item === existing ? candidate : item));
          return candidate;
        }
        // The ledger parser validates each sealed record; projection also refuses a
        // stale/conflicting Auto/Solo pair before this importer appends anything.
        const prior = await this.ledger.load(corpus);
        projectDelegationEvaluationLedger(corpus, [...prior, observation]);
        await this.retainCorpus(corpus);
        await this.ledger.append(bundle.observation, corpus);
        await this.saveBindings([...bindings, candidate]);
        return candidate;
      } finally {
        const info = await lstat(lock).catch(() => undefined);
        if (info?.isFile() && !info.isSymbolicLink() && await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {});
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** Read-only adapter for delegated-run export. It reads durable local references only. */
  async exportEvidence(delegatedRunId: string, corpusValue: unknown): Promise<{ availability: 'available' | 'unavailable'; references: DelegationRunArchiveEvidenceReference[] }> {
    const corpus = parseDelegationEvaluationCorpus(corpusValue), binding = (await this.loadBindings()).find(item => item.delegatedRunId === runId(delegatedRunId));
    if (!binding) return { availability: 'unavailable', references: [] };
    const observation = (await this.ledger.load(corpus)).find(item => item.id === binding.observationId && item.sha256 === binding.observationSha256);
    return observation ? { availability: 'available', references: [{ id: binding.observationId, sha256: binding.observationSha256 }] } : { availability: 'unavailable', references: [] };
  }
  /** Archive adapter: fixed storage paths only; missing legacy corpus bindings stay unavailable. */
  async exportStoredEvidence(delegatedRunId: string): Promise<{ availability: 'available' | 'unavailable'; references: DelegationRunArchiveEvidenceReference[] }> {
    const binding = (await this.loadBindings()).find(item => item.delegatedRunId === runId(delegatedRunId));
    if (!binding?.corpusSha256) return { availability: 'unavailable', references: [] };
    const corpus = await this.savedCorpus(binding.corpusSha256);
    return corpus ? this.exportEvidence(delegatedRunId, corpus) : { availability: 'unavailable', references: [] };
  }
}
