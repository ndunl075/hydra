import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import type { DelegationEvaluationReport, EvaluationDecision, EvaluationPairReport } from './delegationEvaluationReport';
import { replaceAtomic } from './atomicFile';
import { nativeAcceptanceGates, parseNativeAcceptanceRecord, type NativeAcceptanceRecord } from './nativeAcceptanceArtifacts';
import { parseDelegationRunArchive, type DelegationRunArchive } from './delegationRunExport';
import type { ProviderReadinessReport } from './providerReadiness';

export const delegationRolloutReviewVersion = 1 as const;
export type RolloutDecision = 'approve' | 'reject';
export interface RolloutEvaluationReference { id: string; sha256: string; }
export interface ReleaseRolloutProvenance {
  manifestSha256?: string; sourceCommit?: string; signing: 'verified' | 'missing';
  manualGates: Array<{ id: 'distinct-version-upgrade' | 'installer-wizard'; status: 'verified' | 'pending'; evidenceSha256?: string }>;
}
export interface DelegationRolloutReviewPacket {
  version: typeof delegationRolloutReviewVersion;
  evaluation: { report: DelegationEvaluationReport; reportSha256: string; references: RolloutEvaluationReference[] };
  readiness: { reports: ProviderReadinessReport[]; sha256: string };
  nativeAcceptance: { records: NativeAcceptanceRecord[]; sha256: string };
  release: ReleaseRolloutProvenance;
  export: DelegationRunArchive;
  decision: { outcome: RolloutDecision; operator: string; decidedAt: string; rationale: string };
  sha256: string;
}
export interface DelegationRolloutReviewInput {
  evaluation: { report: DelegationEvaluationReport; references?: RolloutEvaluationReference[] };
  readiness: ProviderReadinessReport[];
  nativeAcceptance: NativeAcceptanceRecord[];
  release: ReleaseRolloutProvenance;
  export: DelegationRunArchive;
  decision: { outcome: RolloutDecision; operator: string; decidedAt: string; rationale: string };
}
export interface DelegationRolloutReviewCurrentEvidence {
  evaluation: { report: DelegationEvaluationReport; references?: RolloutEvaluationReference[] };
  readiness: ProviderReadinessReport[];
  nativeAcceptance: NativeAcceptanceRecord[];
  release: ReleaseRolloutProvenance;
  export: DelegationRunArchive;
}
export interface RolloutReviewAssessment { approved: boolean; blockers: string[]; }
export const maxDelegationRolloutReviewPacketBytes = 1024 * 1024;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid rollout review ${label}.`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[], label: string) => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`Invalid rollout review ${label}.`);
};
const sha = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid rollout review ${label}.`);
  return value;
};
const text = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid rollout review ${label}.`);
  return value;
};
const timestamp = (value: unknown, label: string): string => {
  const result = text(value, 24, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || new Date(result).toISOString() !== result) throw new Error(`Invalid rollout review ${label}.`);
  return result;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid rollout review number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = object(value, 'value');
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};
const digest = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const boundedPacket = (value: unknown): void => {
  let bytes: number;
  try { bytes = Buffer.byteLength(typeof value === 'string' ? value : Buffer.isBuffer(value) ? value : JSON.stringify(value), 'utf8'); }
  catch { throw new Error('Invalid rollout review packet.'); }
  if (bytes > maxDelegationRolloutReviewPacketBytes) throw new Error('Rollout review packet exceeds its size bound.');
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); }
  return value;
};

function parseReport(value: unknown): DelegationEvaluationReport {
  const item = object(value, 'evaluation report'); exact(item, ['version', 'decision', 'sampleCount', 'requiredSamples', 'pairs', ...(item.reason === undefined ? [] : ['reason'])], 'evaluation report');
  if (item.version !== 1 || !['insufficient', 'keep-solo', 'eligible-for-human-rollout-review'].includes(item.decision as string) || !Number.isSafeInteger(item.sampleCount) || !Number.isSafeInteger(item.requiredSamples) || (item.sampleCount as number) < 0 || (item.requiredSamples as number) < 1 || !Array.isArray(item.pairs) || item.pairs.length > 1024) throw new Error('Invalid rollout review evaluation report.');
  const pairs = item.pairs.map((value): EvaluationPairReport => {
    const pair = object(value, 'evaluation pair'); exact(pair, ['pairId', 'caseId', 'eligible', 'tokenEfficiency', ...(pair.reason === undefined ? [] : ['reason']), ...(pair.tradeoff === undefined ? [] : ['tradeoff'])], 'evaluation pair');
    if (typeof pair.pairId !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(pair.pairId) || typeof pair.caseId !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(pair.caseId) || typeof pair.eligible !== 'boolean' || !['improved', 'within-tolerance', 'worse', 'partial', 'unavailable'].includes(pair.tokenEfficiency as string) || (pair.reason !== undefined && typeof pair.reason !== 'string') || (pair.tradeoff !== undefined && pair.tradeoff !== 'faster-but-more-expensive')) throw new Error('Invalid rollout review evaluation pair.');
    return { pairId: pair.pairId, caseId: pair.caseId, eligible: pair.eligible, tokenEfficiency: pair.tokenEfficiency as EvaluationPairReport['tokenEfficiency'], ...(pair.reason === undefined ? {} : { reason: text(pair.reason, 4000, 'evaluation pair reason') }), ...(pair.tradeoff === undefined ? {} : { tradeoff: pair.tradeoff }) };
  });
  if (new Set(pairs.map(pair => pair.pairId)).size !== pairs.length) throw new Error('Invalid rollout review duplicate evaluation pair.');
  return { version: 1, decision: item.decision as EvaluationDecision, sampleCount: item.sampleCount as number, requiredSamples: item.requiredSamples as number, pairs, ...(item.reason === undefined ? {} : { reason: text(item.reason, 4000, 'evaluation report reason') }) };
}
function references(value: unknown, allowUnavailable = false): RolloutEvaluationReference[] {
  if (value === undefined && allowUnavailable) return [];
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid rollout review evaluation references.');
  const parsed = value.map(item => { const ref = object(item, 'evaluation reference'); exact(ref, ['id', 'sha256'], 'evaluation reference'); if (typeof ref.id !== 'string' || !/^[a-f0-9]{24}$/.test(ref.id)) throw new Error('Invalid rollout review evaluation reference.'); return { id: ref.id, sha256: sha(ref.sha256, 'evaluation reference SHA-256') }; }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(parsed.map(ref => ref.id)).size !== parsed.length) throw new Error('Invalid rollout review duplicate evaluation reference.');
  return parsed;
}
function readiness(value: unknown): ProviderReadinessReport[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error('Invalid rollout review readiness.');
  const parsed = value.map(entry => { const item = object(entry, 'readiness report'); exact(item, ['provider', 'adapter', 'controls', 'template', 'authorization', 'ready'], 'readiness report'); if (!['claude', 'codex'].includes(item.provider as string) || !['ready', 'unavailable'].includes(item.adapter as string) || !['ready', 'unavailable'].includes(item.controls as string) || !['ready', 'missing'].includes(item.template as string) || !['missing', 'required'].includes(item.authorization as string) || item.ready !== false) throw new Error('Invalid rollout review readiness report.'); return { provider: item.provider as ProviderReadinessReport['provider'], adapter: item.adapter as ProviderReadinessReport['adapter'], controls: item.controls as ProviderReadinessReport['controls'], template: item.template as ProviderReadinessReport['template'], authorization: item.authorization as ProviderReadinessReport['authorization'], ready: false as const }; }).sort((a, b) => a.provider.localeCompare(b.provider));
  if (new Set(parsed.map(item => item.provider)).size !== parsed.length) throw new Error('Invalid rollout review duplicate readiness provider.');
  return parsed;
}
function nativeRecords(value: unknown): NativeAcceptanceRecord[] {
  if (!Array.isArray(value) || value.length !== nativeAcceptanceGates.length) throw new Error('Invalid rollout review native acceptance records.');
  const parsed = value.map(parseNativeAcceptanceRecord).map(record => structuredClone(record)).sort((a, b) => a.gate.localeCompare(b.gate));
  if (new Set(parsed.map(record => record.gate)).size !== nativeAcceptanceGates.length) throw new Error('Invalid rollout review native acceptance records.');
  return parsed;
}
function release(value: unknown): ReleaseRolloutProvenance {
  const item = object(value, 'release provenance'); const hasManifest = item.manifestSha256 !== undefined || item.sourceCommit !== undefined; exact(item, hasManifest ? ['manifestSha256', 'sourceCommit', 'signing', 'manualGates'] : ['signing', 'manualGates'], 'release provenance');
  if ((hasManifest && (typeof item.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(item.sourceCommit))) || (item.signing !== 'verified' && item.signing !== 'missing') || !Array.isArray(item.manualGates) || item.manualGates.length !== 2) throw new Error('Invalid rollout review release provenance.');
  const manualGates = item.manualGates.map(value => { const gate = object(value, 'release manual gate'); const keys = gate.status === 'verified' ? ['id', 'status', 'evidenceSha256'] : ['id', 'status']; exact(gate, keys, 'release manual gate'); if ((gate.id !== 'distinct-version-upgrade' && gate.id !== 'installer-wizard') || (gate.status !== 'verified' && gate.status !== 'pending')) throw new Error('Invalid rollout review release manual gate.'); return { id: gate.id as ReleaseRolloutProvenance['manualGates'][number]['id'], status: gate.status as ReleaseRolloutProvenance['manualGates'][number]['status'], ...(gate.status === 'verified' ? { evidenceSha256: sha(gate.evidenceSha256, 'release manual gate SHA-256') } : {}) }; }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(manualGates.map(gate => gate.id)).size !== 2) throw new Error('Invalid rollout review release manual gates.');
  return { ...(hasManifest ? { manifestSha256: sha(item.manifestSha256, 'release manifest SHA-256'), sourceCommit: item.sourceCommit as string } : {}), signing: item.signing, manualGates };
}
function decision(value: unknown): DelegationRolloutReviewPacket['decision'] {
  const item = object(value, 'decision'); exact(item, ['outcome', 'operator', 'decidedAt', 'rationale'], 'decision');
  if (item.outcome !== 'approve' && item.outcome !== 'reject') throw new Error('Invalid rollout review decision.');
  return { outcome: item.outcome, operator: text(item.operator, 160, 'decision operator'), decidedAt: timestamp(item.decidedAt, 'decision timestamp'), rationale: text(item.rationale, 4000, 'decision rationale') };
}
function unsigned(input: DelegationRolloutReviewInput) {
  const report = parseReport(input.evaluation.report), refs = references(input.evaluation.references, true), archive = parseDelegationRunArchive(input.export);
  const reports = readiness(input.readiness), records = nativeRecords(input.nativeAcceptance), releaseRecord = release(input.release), recordedDecision = decision(input.decision);
  return { version: delegationRolloutReviewVersion, evaluation: { report, reportSha256: digest(report), references: refs }, readiness: { reports, sha256: digest(reports) }, nativeAcceptance: { records, sha256: digest(records) }, release: releaseRecord, export: archive, decision: recordedDecision };
}

/** Creates an immutable, local packet only. It never reads files, starts a process, calls a provider, or changes settings. */
export function createDelegationRolloutReviewPacket(input: DelegationRolloutReviewInput): DelegationRolloutReviewPacket {
  const packet = unsigned(input);
  boundedPacket(packet);
  return freeze({ ...packet, sha256: digest(packet) });
}

/** Restores and authenticates a durable packet. Canonical hashing makes replay independent of object key order. */
export function parseDelegationRolloutReviewPacket(value: unknown): DelegationRolloutReviewPacket {
  boundedPacket(value);
  let source: unknown = value;
  try { if (typeof value === 'string' || Buffer.isBuffer(value)) source = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value); } catch { throw new Error('Invalid rollout review packet.'); }
  const item = object(source, 'packet'); exact(item, ['version', 'evaluation', 'readiness', 'nativeAcceptance', 'release', 'export', 'decision', 'sha256'], 'packet');
  if (item.version !== delegationRolloutReviewVersion) throw new Error('Invalid rollout review packet.');
  const evaluation = object(item.evaluation, 'evaluation'); exact(evaluation, ['report', 'reportSha256', 'references'], 'evaluation');
  const report = parseReport(evaluation.report), refs = references(evaluation.references);
  if (sha(evaluation.reportSha256, 'report SHA-256') !== digest(report)) throw new Error('Rollout review report hash mismatch.');
  const ready = object(item.readiness, 'readiness'); exact(ready, ['reports', 'sha256'], 'readiness'); const reports = readiness(ready.reports);
  if (sha(ready.sha256, 'readiness SHA-256') !== digest(reports)) throw new Error('Rollout review readiness hash mismatch.');
  const native = object(item.nativeAcceptance, 'native acceptance'); exact(native, ['records', 'sha256'], 'native acceptance'); const records = nativeRecords(native.records);
  if (sha(native.sha256, 'native acceptance SHA-256') !== digest(records)) throw new Error('Rollout review native acceptance hash mismatch.');
  const packet = { version: delegationRolloutReviewVersion, evaluation: { report, reportSha256: digest(report), references: refs }, readiness: { reports, sha256: digest(reports) }, nativeAcceptance: { records, sha256: digest(records) }, release: release(item.release), export: parseDelegationRunArchive(item.export), decision: decision(item.decision) };
  boundedPacket(packet);
  if (sha(item.sha256, 'packet SHA-256') !== digest(packet)) throw new Error('Rollout review packet hash mismatch.');
  return freeze({ ...packet, sha256: digest(packet) });
}

/** Compares a sealed packet to supplied current facts. A caller must supply new facts; this module never probes external state. */
export function assessDelegationRolloutReview(packetValue: unknown, current: DelegationRolloutReviewCurrentEvidence): RolloutReviewAssessment {
  const packet = parseDelegationRolloutReviewPacket(packetValue), latest = unsigned({ ...current, decision: packet.decision });
  const blockers: string[] = [];
  if (packet.decision.outcome !== 'approve') blockers.push('The human decision is not approval.');
  if (packet.evaluation.report.decision !== 'eligible-for-human-rollout-review') blockers.push('The evaluation report is not eligible for human rollout review.');
  const completePairs = packet.evaluation.report.pairs.filter(pair => pair.eligible && !pair.reason && (pair.tokenEfficiency === 'improved' || pair.tokenEfficiency === 'within-tolerance'));
  if (packet.evaluation.report.sampleCount < packet.evaluation.report.requiredSamples || completePairs.length < packet.evaluation.report.requiredSamples || packet.evaluation.report.pairs.some(pair => !pair.eligible || !!pair.reason || !['improved', 'within-tolerance'].includes(pair.tokenEfficiency))) blockers.push('The evaluation report lacks complete eligible sample evidence.');
  if (!packet.evaluation.references.length || packet.export.evaluationEvidence.availability !== 'available' || !packet.export.evaluationEvidence.references.length) blockers.push('External evaluation evidence is unavailable.');
  if (canonical(packet.evaluation.references) !== canonical(packet.export.evaluationEvidence.references)) blockers.push('Evaluation references do not match the exported archive.');
  if (packet.evaluation.reportSha256 !== latest.evaluation.reportSha256) blockers.push('The evaluation report hash is stale.');
  if (packet.readiness.sha256 !== latest.readiness.sha256) blockers.push('The provider readiness facts are stale.');
  if (packet.nativeAcceptance.sha256 !== latest.nativeAcceptance.sha256) blockers.push('The native acceptance artifact hashes are stale.');
  if (canonical(packet.release) !== canonical(latest.release)) blockers.push('The release provenance is stale.');
  if (packet.export.sha256 !== latest.export.sha256) blockers.push('The delegated-run export hash is stale.');
  if (canonical(packet.evaluation.references) !== canonical(latest.evaluation.references)) blockers.push('The evaluation evidence references are stale.');
  if (packet.nativeAcceptance.records.some(record => record.status !== 'verified' || !record.artifacts.length)) blockers.push('Required native acceptance artifacts are incomplete.');
  if (!packet.release.manifestSha256 || !packet.release.sourceCommit) blockers.push('Release manifest provenance is missing.');
  if (packet.release.signing !== 'verified') blockers.push('Release signing evidence is missing.');
  if (packet.release.manualGates.some(gate => gate.status !== 'verified' || !gate.evidenceSha256)) blockers.push('Required release manual evidence is incomplete.');
  if (packet.readiness.reports.some(report => report.adapter !== 'ready' || report.controls !== 'ready' || report.template !== 'ready' || report.authorization !== 'required')) blockers.push('Provider readiness facts are incomplete.');
  const provenanceMismatch = (native: typeof packet.nativeAcceptance, release: typeof packet.release) => !!release.sourceCommit && native.records.some(record => record.artifacts.some(artifact => artifact.provenance.sourceCommit !== release.sourceCommit));
  if (provenanceMismatch(packet.nativeAcceptance, packet.release) || provenanceMismatch(latest.nativeAcceptance, latest.release)) blockers.push('Native acceptance artifact provenance does not match the release source commit.');
  const decidedAt = Date.parse(packet.decision.decidedAt);
  if (packet.nativeAcceptance.records.some(record => decidedAt < Date.parse(record.recordedAt) || record.artifacts.some(artifact => decidedAt < Date.parse(artifact.capturedAt)))) blockers.push('The human decision predates native acceptance evidence.');
  return { approved: blockers.length === 0, blockers };
}

/** Small atomic local store for a sealed packet. It has no provider, process, or preference dependency. */
export class DelegationRolloutReviewStore {
  constructor(private readonly filename: string) {}
  async load(): Promise<DelegationRolloutReviewPacket | undefined> {
    let source: Buffer;
    try { source = await readFile(this.filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (source.length > maxDelegationRolloutReviewPacketBytes) throw new Error('Rollout review packet exceeds its size bound.');
    return parseDelegationRolloutReviewPacket(source);
  }
  /** A write requires the observed prior hash; omit it only when creating a new record. */
  async save(value: unknown, expectedPriorSha256?: string): Promise<DelegationRolloutReviewPacket> {
    const packet = parseDelegationRolloutReviewPacket(value);
    const encoded = JSON.stringify(packet, null, 2);
    if (Buffer.byteLength(encoded, 'utf8') > maxDelegationRolloutReviewPacketBytes) throw new Error('Rollout review packet exceeds its size bound.');
    await mkdir(dirname(this.filename), { recursive: true });
    const lock = `${this.filename}.lock`, token = randomUUID();
    await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Rollout review packet has another writer or retained lock. Inspect and reconcile local storage before retrying.'); throw error; });
    try {
      const previous = await this.load();
      if ((previous && expectedPriorSha256 !== previous.sha256) || (!previous && expectedPriorSha256 !== undefined)) throw new Error('Rollout review packet write conflict.');
      const temporary = join(dirname(this.filename), `.${basename(this.filename)}.${randomUUID()}.tmp`);
      try { const handle = await open(temporary, 'wx'); try { await handle.writeFile(encoded, 'utf8'); await handle.sync(); } finally { await handle.close(); } await replaceAtomic(temporary, this.filename); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      return packet;
    } finally {
      const info = await lstat(lock).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink() && await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {});
    }
  }
}
