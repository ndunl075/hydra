import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceAtomic } from './atomicFile';
import { digest } from './delegationContext';
import { parseDelegationEvaluationCorpus, parseEvaluationRunDescriptor, type DelegationEvaluationCorpus, type EvaluationRunDescriptor } from './delegationEvaluationCorpus';

export type ObservationStatus = 'passed' | 'failed' | 'unavailable';
export type ReportedUsageCoverage = 'available' | 'partial' | 'unavailable';
export interface LedgerArtifactReference { label: string; path: string; sha256: string; }
export interface DelegationEvaluationObservation {
  version: 1; id: string; pairId: string; runId: string; descriptor: EvaluationRunDescriptor;
  acceptance: ObservationStatus; quality: { status: ObservationStatus; score?: number };
  elapsedTime: { status: ObservationStatus; milliseconds?: number };
  reportedUsage: { coverage: ReportedUsageCoverage; tokens?: number };
  regressions: { status: ObservationStatus; count?: number };
  integrationConflicts: { status: ObservationStatus; count?: number };
  manualRework: { status: ObservationStatus; minutes?: number };
  artifacts: LedgerArtifactReference[]; sha256: string;
}
export interface EvaluationPairProjection {
  pairId: string; caseId: string; auto?: DelegationEvaluationObservation; solo?: DelegationEvaluationObservation;
  complete: boolean; usageCoverage: ReportedUsageCoverage; quality: 'available' | 'unavailable';
}

const id = (value: unknown, name: string) => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new Error(`Invalid evaluation ledger ${name}.`); return value; };
const sha = (value: unknown, name: string) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid evaluation ledger ${name}.`); return value; };
const status = (value: unknown, name: string): ObservationStatus => { if (!['passed', 'failed', 'unavailable'].includes(value as string)) throw new Error(`Invalid evaluation ledger ${name}.`); return value as ObservationStatus; };
const nonnegative = (value: unknown, name: string) => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid evaluation ledger ${name}.`); return value as number; };
const exact = (value: Record<string, unknown>, keys: string[]) => { if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('Invalid evaluation ledger fields.'); };
const clone = <T>(value: T): T => structuredClone(value);
const maxLedgerBytes = 2 * 1024 * 1024;

function artifact(value: unknown): LedgerArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evaluation ledger artifact.');
  const input = value as Record<string, unknown>; exact(input, ['label', 'path', 'sha256']);
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 500 || typeof input.path !== 'string' || !input.path || input.path.length > 4096 || input.path.includes('\\') || input.path.startsWith('/') || input.path.includes(':') || input.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid evaluation ledger artifact.');
  return { label: input.label, path: input.path, sha256: sha(input.sha256, 'artifact SHA-256') };
}
function metric(value: unknown, name: string, field: 'score' | 'milliseconds' | 'count' | 'minutes'): { status: ObservationStatus; [key: string]: number | ObservationStatus | undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid evaluation ledger ${name}.`);
  const input = value as Record<string, unknown>; exact(input, input[field] === undefined ? ['status'] : ['status', field]);
  const result: { status: ObservationStatus; [key: string]: number | ObservationStatus | undefined } = { status: status(input.status, name) };
  if (input[field] !== undefined) result[field] = field === 'score' ? (() => { if (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] < 0 || input[field] > 100) throw new Error(`Invalid evaluation ledger ${name}.`); return input[field] as number; })() : nonnegative(input[field], name);
  if (result.status === 'unavailable' && input[field] !== undefined) throw new Error(`Unavailable evaluation ledger ${name} cannot claim a value.`);
  if (result.status !== 'unavailable' && input[field] === undefined) throw new Error(`Available evaluation ledger ${name} requires a value.`);
  return result;
}

/** Parses only supplied local evidence. It never reads artifact contents, provider state, logs, or transcripts. */
export function parseDelegationEvaluationObservation(value: unknown, corpusValue: unknown): DelegationEvaluationObservation {
  const corpus = parseDelegationEvaluationCorpus(corpusValue);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evaluation ledger observation.');
  const input = value as Record<string, unknown>;
  exact(input, ['version', 'id', 'pairId', 'runId', 'descriptor', 'acceptance', 'quality', 'elapsedTime', 'reportedUsage', 'regressions', 'integrationConflicts', 'manualRework', 'artifacts', 'sha256']);
  if (input.version !== 1) throw new Error('Invalid evaluation ledger schema version.');
  const descriptor = parseEvaluationRunDescriptor(input.descriptor);
  const baseline = corpus.cases.find(item => item.id === descriptor.caseId);
  if (!baseline || descriptor.corpusId !== corpus.id || descriptor.corpusSha256 !== corpus.sha256 || descriptor.caseSha256 !== baseline.caseSha256) throw new Error('Evaluation ledger observation does not bind to the immutable corpus case.');
  const reported = input.reportedUsage as Record<string, unknown>;
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) throw new Error('Invalid evaluation ledger reported usage.');
  exact(reported, reported.tokens === undefined ? ['coverage'] : ['coverage', 'tokens']);
  if (!['available', 'partial', 'unavailable'].includes(reported.coverage as string) || (reported.tokens !== undefined && nonnegative(reported.tokens, 'reported tokens') > baseline.budgetCeiling.maxReportedTokens) || (reported.coverage === 'unavailable' && reported.tokens !== undefined) || (reported.coverage !== 'unavailable' && reported.tokens === undefined)) throw new Error('Invalid evaluation ledger reported usage.');
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 32) throw new Error('Invalid evaluation ledger artifacts.');
  const unsigned = { version: 1 as const, id: id(input.id, 'id'), pairId: id(input.pairId, 'pair id'), runId: id(input.runId, 'run id'), descriptor,
    acceptance: status(input.acceptance, 'acceptance'), quality: metric(input.quality, 'quality', 'score') as { status: ObservationStatus; score?: number }, elapsedTime: metric(input.elapsedTime, 'elapsed time', 'milliseconds') as { status: ObservationStatus; milliseconds?: number },
    reportedUsage: { coverage: reported.coverage as ReportedUsageCoverage, ...(reported.tokens === undefined ? {} : { tokens: reported.tokens as number }) }, regressions: metric(input.regressions, 'regressions', 'count') as { status: ObservationStatus; count?: number }, integrationConflicts: metric(input.integrationConflicts, 'integration conflicts', 'count') as { status: ObservationStatus; count?: number }, manualRework: metric(input.manualRework, 'manual rework', 'minutes') as { status: ObservationStatus; minutes?: number }, artifacts: input.artifacts.map(artifact) };
  const observationSha = sha(input.sha256, 'SHA-256');
  if (digest(JSON.stringify(unsigned)) !== observationSha) throw new Error('Evaluation ledger observation changed. Supply a new immutable observation.');
  return { ...unsigned, sha256: observationSha };
}

function coverage(records: DelegationEvaluationObservation[]): ReportedUsageCoverage {
  if (records.some(item => item.reportedUsage.coverage === 'unavailable')) return 'unavailable';
  return records.some(item => item.reportedUsage.coverage === 'partial') ? 'partial' : 'available';
}
export function projectDelegationEvaluationLedger(corpusValue: unknown, values: unknown[]): EvaluationPairProjection[] {
  const corpus = parseDelegationEvaluationCorpus(corpusValue), records = values.map(value => parseDelegationEvaluationObservation(value, corpus));
  const groups = new Map<string, DelegationEvaluationObservation[]>();
  for (const record of records) { const group = groups.get(record.pairId) || []; group.push(record); groups.set(record.pairId, group); }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pairId, group]) => {
    if (new Set(group.map(item => item.runId)).size !== group.length) throw new Error('Evaluation ledger contains duplicate run evidence.');
    if (new Set(group.map(item => `${item.descriptor.corpusSha256}:${item.descriptor.caseSha256}`)).size !== 1) throw new Error('Evaluation ledger pair has conflicting immutable bindings.');
    const auto = group.find(item => item.descriptor.mode === 'auto'), solo = group.find(item => item.descriptor.mode === 'solo');
    if (group.filter(item => item.descriptor.mode === 'auto').length > 1 || group.filter(item => item.descriptor.mode === 'solo').length > 1) throw new Error('Evaluation ledger pair has conflicting mode evidence.');
    return { pairId, caseId: group[0]!.descriptor.caseId, auto, solo, complete: !!auto && !!solo, usageCoverage: coverage(group), quality: group.every(item => item.quality.status !== 'unavailable') ? 'available' : 'unavailable' };
  });
}

/** Append-only local evidence store. Exact replay is a no-op; a changed run ID fails closed. */
export class DelegationEvaluationLedger {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private file() { return path.join(this.directory, 'delegation-evaluation-ledger.json'); }
  private lock() { return `${this.file()}.lock`; }
  async load(corpus: unknown): Promise<DelegationEvaluationObservation[]> {
    let bytes: Buffer;
    try { const info = await lstat(this.file()); if (!info.isFile() || info.isSymbolicLink() || info.size > maxLedgerBytes) throw new Error('Invalid evaluation ledger storage. Original data has been retained.'); bytes = await readFile(this.file()); if (bytes.length > maxLedgerBytes) throw new Error('Evaluation ledger exceeds its size bound. Original data has been retained.'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const raw = bytes.toString('utf8');
    const input = JSON.parse(raw) as { version?: unknown; observations?: unknown };
    if (!input || input.version !== 1 || !Array.isArray(input.observations) || input.observations.length > 10_000) throw new Error('Invalid evaluation ledger store. Original data has been retained.');
    const records = input.observations.map(item => parseDelegationEvaluationObservation(item, corpus));
    if (new Set(records.map(item => item.runId)).size !== records.length) throw new Error('Evaluation ledger contains duplicate run evidence. Original data has been retained.');
    return records;
  }
  append(value: unknown, corpus: unknown): Promise<DelegationEvaluationObservation> {
    const operation = this.queue.then(async () => {
      const observation = parseDelegationEvaluationObservation(value, corpus); await mkdir(this.directory, { recursive: true });
      const lock = this.lock(), token = randomUUID();
      await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Evaluation ledger has another writer or a retained lock. Inspect and reconcile its local storage before retrying.'); throw error; });
      try {
        const prior = await this.load(corpus), existing = prior.find(item => item.runId === observation.runId);
        if (existing) { if (existing.sha256 === observation.sha256) return existing; throw new Error('Evaluation ledger run evidence conflicts with its immutable prior observation.'); }
        const bytes = Buffer.from(JSON.stringify({ version: 1, observations: [...prior, observation] }, null, 2), 'utf8');
        if (bytes.length > maxLedgerBytes) throw new Error('Evaluation ledger exceeds its size bound.');
        const temporary = path.join(this.directory, `delegation-evaluation-${randomUUID()}.tmp`);
        try { const handle = await open(temporary, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await replaceAtomic(temporary, this.file()); }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
        return observation;
      } finally {
        const info = await lstat(lock).catch(() => undefined);
        if (info?.isFile() && !info.isSymbolicLink() && await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {});
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
