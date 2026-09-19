import { createHash } from 'node:crypto';
import { parseDelegationResultReceipt, type DelegationResultReceipt, type ResultReceiptBinding } from './delegationResults';

const maxChildren = 8, maxContentBytes = 12 * 1024;

export interface AutoDelegationSavedWakeup {
  version: 1;
  parentId: string;
  runId: string;
  /** Immutable receipt hashes captured when the host persisted this wakeup. */
  receiptSha256s: string[];
  wakeupKey: string;
}

/** The durable child identity is supplied by the host's saved delegation records. */
export interface AutoDelegationParentResumeChild {
  parentId: string;
  runId: string;
  childKey: string;
  dispatchKey: string;
  state: 'finished' | 'failed';
}

/** A result and the immutable binding retained by DelegationOrchestrationJournal. */
export interface AutoDelegationParentResumeResultRecord {
  binding: ResultReceiptBinding;
  receipt: unknown;
}

export interface AutoDelegationParentResumeInput {
  wakeup: AutoDelegationSavedWakeup;
  children: readonly AutoDelegationParentResumeChild[];
  results: readonly AutoDelegationParentResumeResultRecord[];
}

export interface AutoDelegationParentResumeReference {
  childKey: string;
  receiptSha256: string;
  commit: string;
  tree: string;
  summary: string;
}

export interface AutoDelegationParentResumePayload {
  version: 1;
  parentId: string;
  runId: string;
  wakeupKey: string;
  /** Stable across replay and process restart for the same wakeup and results. */
  resumeId: string;
  resultReferences: AutoDelegationParentResumeReference[];
  unresolvedCaveats: string[];
  /** Compact provider input. It contains receipt references, never transcripts or logs. */
  content: string;
}

export type AutoDelegationParentResume =
  | { status: 'ready'; payload: AutoDelegationParentResumePayload }
  | { status: 'blocked'; reason: 'invalid-input' | 'wakeup-mismatch' | 'incomplete-wakeup-snapshot' | 'failed-child' | 'payload-too-large'; childKeys?: string[]; receiptSha256s?: string[] };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const wakeupKeyFor = (receiptSha256s: readonly string[]) => sha256([...receiptSha256s].sort().join('\n'));
const canonical = (value: unknown) => JSON.stringify(value);
const receiptSha256 = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const sha256 = (value as { sha256?: unknown }).sha256;
  return typeof sha256 === 'string' ? sha256 : undefined;
};

/**
 * Produces only a bounded continuation value from already-durable facts. It
 * never wakes a scheduler, mutates a task, or submits a provider/model turn.
 */
export function createAutoDelegationParentResume(input: AutoDelegationParentResumeInput): AutoDelegationParentResume {
  const { wakeup, children, results } = input;
  if (!wakeup || wakeup.version !== 1 || !/^[a-f0-9]{12}$/.test(wakeup.parentId) || !/^[a-f0-9]{12}$/.test(wakeup.runId) || !Array.isArray(wakeup.receiptSha256s) || !wakeup.receiptSha256s.length || wakeup.receiptSha256s.length > maxChildren || new Set(wakeup.receiptSha256s).size !== wakeup.receiptSha256s.length || wakeup.receiptSha256s.some(receipt => !/^[a-f0-9]{64}$/.test(receipt)) || !/^[a-f0-9]{64}$/.test(wakeup.wakeupKey) || !Array.isArray(children) || !Array.isArray(results) || !children.length || children.length > maxChildren || new Set(children.map(child => child.childKey)).size !== children.length) return { status: 'blocked', reason: 'invalid-input' };
  if (children.some(child => child.parentId !== wakeup.parentId || child.runId !== wakeup.runId || !/^[a-z][a-z0-9_-]{0,63}$/.test(child.childKey) || !/^[a-f0-9]{24}$/.test(child.dispatchKey) || !['finished', 'failed'].includes(child.state))) return { status: 'blocked', reason: 'invalid-input' };

  const failed = children.filter(child => child.state === 'failed').map(child => child.childKey).sort();
  if (failed.length) return { status: 'blocked', reason: 'failed-child', childKeys: failed };

  if (wakeupKeyFor(wakeup.receiptSha256s) !== wakeup.wakeupKey) return { status: 'blocked', reason: 'wakeup-mismatch' };

  const savedReceiptSha256s = new Set(wakeup.receiptSha256s);
  const selectedRecords = results.filter(record => {
    const sha256 = receiptSha256(record.receipt);
    return sha256 !== undefined && savedReceiptSha256s.has(sha256);
  });
  const selectedSha256s = selectedRecords.map(record => receiptSha256(record.receipt)!);
  const incomplete = wakeup.receiptSha256s.filter(receipt => !selectedSha256s.includes(receipt));
  if (incomplete.length) return { status: 'blocked', reason: 'incomplete-wakeup-snapshot', receiptSha256s: incomplete.sort() };
  if (new Set(selectedSha256s).size !== selectedSha256s.length) return { status: 'blocked', reason: 'invalid-input' };

  let receipts: DelegationResultReceipt[];
  try {
    receipts = selectedRecords.map(record => parseDelegationResultReceipt(record.receipt, record.binding));
  } catch {
    return { status: 'blocked', reason: 'invalid-input' };
  }
  if (receipts.length > maxChildren || new Set(receipts.map(receipt => receipt.childKey)).size !== receipts.length || receipts.some(receipt => receipt.parentId !== wakeup.parentId || receipt.runId !== wakeup.runId || !savedReceiptSha256s.has(receipt.sha256))) return { status: 'blocked', reason: 'invalid-input' };

  const mismatched = receipts.filter(receipt => {
    const child = children.find(candidate => candidate.childKey === receipt.childKey);
    return !child || child.dispatchKey !== receipt.dispatchKey;
  }).map(receipt => receipt.childKey).sort();
  if (mismatched.length) return { status: 'blocked', reason: 'invalid-input', childKeys: mismatched };
  if (wakeup.receiptSha256s.some(receipt => !receipts.some(candidate => candidate.sha256 === receipt))) return { status: 'blocked', reason: 'incomplete-wakeup-snapshot', receiptSha256s: wakeup.receiptSha256s.filter(receipt => !receipts.some(candidate => candidate.sha256 === receipt)).sort() };
  /* The wakeup can intentionally contain a partial receipt snapshot. Children
     that completed after the host persisted it belong to a later wakeup. */

  const ordered = [...receipts].sort((left, right) => left.childKey.localeCompare(right.childKey));
  const resultReferences = ordered.map(receipt => ({ childKey: receipt.childKey, receiptSha256: receipt.sha256, commit: receipt.commit, tree: receipt.tree, summary: receipt.summary }));
  const unresolvedCaveats = ordered.flatMap(receipt => receipt.unresolved.map(issue => `${receipt.childKey}: ${issue}`));
  const content = [
    'Delegated child results are ready. Continue only from these durable receipt references.',
    ...resultReferences.map(reference => `- ${reference.childKey}: ${reference.summary} (receipt ${reference.receiptSha256})`),
    ...(unresolvedCaveats.length ? ['Unresolved caveats:', ...unresolvedCaveats.map(issue => `- ${issue}`)] : ['No child reported unresolved caveats.'])
  ].join('\n');
  if (Buffer.byteLength(content, 'utf8') > maxContentBytes) return { status: 'blocked', reason: 'payload-too-large' };
  const resumeId = sha256(canonical({ version: 1, parentId: wakeup.parentId, runId: wakeup.runId, wakeupKey: wakeup.wakeupKey, resultReferences, unresolvedCaveats }));
  return { status: 'ready', payload: { version: 1, parentId: wakeup.parentId, runId: wakeup.runId, wakeupKey: wakeup.wakeupKey, resumeId, resultReferences, unresolvedCaveats, content } };
}
