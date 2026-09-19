import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceAtomic } from './atomicFile';
import { digest, id, key, record, text } from './delegationContext';
import { assertDelegatedVerificationGate, type DelegatedVerificationEvidence } from './delegationEvidence';
import { parseDelegationResultReceipt, type DelegationResultReceipt, type ResultReceiptBinding } from './delegationResults';
import type { Task } from './model';

export type ParentReviewDecision = 'approved' | 'rejected';
export interface DelegationParentReviewReceipt {
  version: 1;
  parentId: string;
  runId: string;
  childKey: string;
  resultSha256: string;
  evidenceSha256: string;
  commit: string;
  tree: string;
  reviewer: 'parent-human';
  decision: ParentReviewDecision;
  reviewedAt: string;
  reason: string;
  sha256: string;
}
export interface ParentReviewSource {
  child: Pick<Task, 'delegation' | 'reviewedCommit' | 'verificationEvidence'>;
  /** Captured from the host's durable dispatch, never inferred from provider output. */
  binding: ResultReceiptBinding;
  result: DelegationResultReceipt;
}

const maxBytes = 512 * 1024, maxReceipts = 128;
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid parent review ${label}.`);
  return value;
};
const oid = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`Invalid parent review ${label}.`);
  return value;
};
const timestamp = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error('Invalid parent review timestamp.');
  return value;
};
function reviewReason(value: unknown): string {
  const result = text(value, 1200, 'parent review reason');
  if (/[\r\n\x1b`]/.test(result) || /\b(?:tap version \d+|# subtest:|assertionerror|stack trace|npm err!|stdout:|stderr:|\{\s*"role"\s*:|\[?(?:user|assistant|system)\]?\s*:)/i.test(result)) throw new Error('Parent review reason must be concise and cannot contain a transcript or log.');
  return result;
}
function unsigned(value: Omit<DelegationParentReviewReceipt, 'sha256'>) { return value; }
function receiptHash(value: Omit<DelegationParentReviewReceipt, 'sha256'>) { return digest(JSON.stringify(unsigned(value))); }

/** Validates the host facts currently eligible for a human parent decision. */
export function assertCurrentParentReviewInput(source: ParentReviewSource): { parentId: string; runId: string; childKey: string; resultSha256: string; evidenceSha256: string; commit: string; tree: string } {
  const link = source.child.delegation;
  if (!link || !source.child.reviewedCommit || !source.child.verificationEvidence) throw new Error('A current delegated child review and verification record are required before parent review.');
  assertDelegatedVerificationGate(source.child);
  const parentId = id(link.parentId), runId = id(link.runId), childKey = key(link.childKey);
  const result = parseDelegationResultReceipt(source.result, source.binding);
  if (source.binding.parentId !== parentId || source.binding.runId !== runId || source.binding.childKey !== childKey || source.binding.dispatchKey !== link.dispatchKey || result.parentId !== parentId || result.runId !== runId || result.childKey !== childKey) throw new Error('Parent review result receipt does not match the current delegated child.');
  if (result.commit !== source.child.reviewedCommit.commit || result.tree !== source.child.reviewedCommit.tree) throw new Error('Parent review result boundary is stale. Inspect the current reviewed child result before deciding.');
  const evidenceSha256 = digest(JSON.stringify(source.child.verificationEvidence));
  return { parentId, runId, childKey, resultSha256: result.sha256, evidenceSha256, commit: source.child.reviewedCommit.commit, tree: source.child.reviewedCommit.tree };
}

/** Creates an immutable receipt from an explicit human decision; summaries cannot produce one. */
export function prepareParentReviewReceipt(value: unknown, source: ParentReviewSource): DelegationParentReviewReceipt {
  const current = assertCurrentParentReviewInput(source);
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'resultSha256', 'evidenceSha256', 'commit', 'tree', 'reviewer', 'decision', 'reviewedAt', 'reason']);
  if (item.version !== 1 || item.parentId !== current.parentId || item.runId !== current.runId || item.childKey !== current.childKey || item.resultSha256 !== current.resultSha256 || item.evidenceSha256 !== current.evidenceSha256 || item.commit !== current.commit || item.tree !== current.tree) throw new Error('Parent review decision is stale or belongs to a different result boundary.');
  if (item.reviewer !== 'parent-human' || (item.decision !== 'approved' && item.decision !== 'rejected')) throw new Error('Parent review requires an explicit human approval or rejection.');
  const parsed = { version: 1 as const, ...current, reviewer: 'parent-human' as const, decision: item.decision as ParentReviewDecision, reviewedAt: timestamp(item.reviewedAt), reason: reviewReason(item.reason) };
  return { ...parsed, sha256: receiptHash(parsed) };
}

function parseStoredReceipt(value: unknown): DelegationParentReviewReceipt {
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'resultSha256', 'evidenceSha256', 'commit', 'tree', 'reviewer', 'decision', 'reviewedAt', 'reason', 'sha256']);
  if (item.version !== 1 || item.reviewer !== 'parent-human' || (item.decision !== 'approved' && item.decision !== 'rejected')) throw new Error('Invalid parent review receipt. Original data was retained.');
  const parsed = { version: 1 as const, parentId: id(item.parentId), runId: id(item.runId), childKey: key(item.childKey), resultSha256: hash(item.resultSha256, 'result hash'), evidenceSha256: hash(item.evidenceSha256, 'evidence hash'), commit: oid(item.commit, 'commit'), tree: oid(item.tree, 'tree'), reviewer: 'parent-human' as const, decision: item.decision as ParentReviewDecision, reviewedAt: timestamp(item.reviewedAt), reason: reviewReason(item.reason) };
  if (hash(item.sha256, 'receipt hash') !== receiptHash(parsed)) throw new Error('Invalid parent review receipt. Original data was retained.');
  return { ...parsed, sha256: item.sha256 as string };
}

/** Durable, append-only audit store. It has no integration or provider side effects. */
export class DelegationParentReviewJournal {
  private queue = new Map<string, Promise<void>>();
  constructor(private readonly directory: string, private readonly assertOwner: () => Promise<void> = async () => {}) {}
  private file(parentId: string, runId: string) { return path.join(this.directory, `parent-review-${parentId}-${runId}.json`); }
  private async read(parentId: string, runId: string): Promise<DelegationParentReviewReceipt[]> {
    const file = this.file(parentId, runId);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid parent review journal storage. Original data was retained.'); const bytes = await readFile(file); const entries = JSON.parse(bytes.toString('utf8')); if (!Array.isArray(entries) || entries.length > maxReceipts) throw new Error('Invalid parent review journal. Original data was retained.'); const parsed = entries.map(parseStoredReceipt); if (parsed.some(item => item.parentId !== parentId || item.runId !== runId) || new Set(parsed.map(item => item.sha256)).size !== parsed.length) throw new Error('Invalid parent review journal identity. Original data was retained.'); return parsed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async save(parentId: string, runId: string, entries: DelegationParentReviewReceipt[]): Promise<void> {
    const file = this.file(parentId, runId), bytes = JSON.stringify(entries, null, 2); if (Buffer.byteLength(bytes, 'utf8') > maxBytes) throw new Error('Parent review journal exceeds its size bound.'); await mkdir(this.directory, { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx'); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } try { await this.assertOwner(); await replaceAtomic(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async load(parentId: string, runId: string): Promise<DelegationParentReviewReceipt[]> { return clone(await this.read(id(parentId), id(runId))); }
  async append(value: unknown, source: ParentReviewSource): Promise<DelegationParentReviewReceipt> {
    const receipt = prepareParentReviewReceipt(value, source), journalKey = `${receipt.parentId}-${receipt.runId}`, operation = (this.queue.get(journalKey) || Promise.resolve()).then(async () => {
      const lock = `${this.file(receipt.parentId, receipt.runId)}.lock`, token = randomUUID(); await mkdir(this.directory, { recursive: true }); await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Parent review journal has another writer or retained lock. Reconcile ownership before retrying.'); throw error; });
      try { const entries = await this.read(receipt.parentId, receipt.runId), prior = entries.find(item => item.resultSha256 === receipt.resultSha256 && item.evidenceSha256 === receipt.evidenceSha256); if (prior) { if (prior.sha256 !== receipt.sha256) throw new Error('Conflicting parent review decision for the same result evidence. Original record was retained.'); return prior; } entries.push(receipt); await this.save(receipt.parentId, receipt.runId, entries); return receipt; }
      finally { if (await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {}); }
    });
    this.queue.set(journalKey, operation.then(() => {}, () => {})); return clone(await operation);
  }
}

/** Integration wiring must call this against the current source; a rejection and every stale/missing review block acceptance. */
export function assertCurrentParentReviewApproved(receipts: readonly DelegationParentReviewReceipt[], source: ParentReviewSource): DelegationParentReviewReceipt {
  const current = assertCurrentParentReviewInput(source), matches = receipts.filter(item => item.resultSha256 === current.resultSha256 && item.evidenceSha256 === current.evidenceSha256);
  if (matches.length !== 1) throw new Error('Combined acceptance requires one current explicit parent review decision.');
  const receipt = matches[0]!;
  if (receipt.sha256 !== receiptHash({ version: receipt.version, parentId: receipt.parentId, runId: receipt.runId, childKey: receipt.childKey, resultSha256: receipt.resultSha256, evidenceSha256: receipt.evidenceSha256, commit: receipt.commit, tree: receipt.tree, reviewer: receipt.reviewer, decision: receipt.decision, reviewedAt: receipt.reviewedAt, reason: receipt.reason })) throw new Error('Parent review decision is stale or malformed.');
  if (receipt.parentId !== current.parentId || receipt.runId !== current.runId || receipt.childKey !== current.childKey || receipt.commit !== current.commit || receipt.tree !== current.tree) throw new Error('Parent review decision is stale for the current child result.');
  if (receipt.decision !== 'approved') throw new Error('Parent review does not explicitly approve this child result; combined acceptance is blocked.');
  return clone(receipt);
}
