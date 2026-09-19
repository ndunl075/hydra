import { createHash } from 'node:crypto';
import type { DelegationReconciliationProjection } from './delegationReconciliation';
import type { Task } from './model';

export const delegationRunArchiveVersion = 1 as const;
export const maxDelegationRunArchiveBytes = 1024 * 1024;

export interface DelegationRunArchiveEvidenceReference {
  id: string;
  sha256: string;
}

export interface DelegationRunArchiveChild {
  taskId: string;
  childKey: string;
  dispatchKey: string;
  dependencies: string[];
  provider: 'claude' | 'codex';
  state: Task['state'];
  reviewed?: { commit: string; tree: string; baseCommit: string };
  boundaries: Array<{ prior: { commit: string; tree: string; baseCommit: string }; replacement: { commit: string; tree: string; baseCommit: string }; evidenceSha256: string; archivedAt: string }>;
}

export interface DelegationRunArchive {
  version: typeof delegationRunArchiveVersion;
  parentId: string;
  runId: string;
  children: DelegationRunArchiveChild[];
  evaluationEvidence: { availability: 'available' | 'unavailable'; references: DelegationRunArchiveEvidenceReference[] };
  recovery: DelegationReconciliationProjection;
  sha256: string;
}

export interface DelegationRunArchiveInput {
  parent: Task;
  runId: string;
  tasks: Task[];
  /** Omit when this host has no durable evaluation ledger/corpus binding to export. */
  evaluationEvidence?: DelegationRunArchiveEvidenceReference[];
  recovery?: DelegationReconciliationProjection;
}

const taskId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) throw new Error(`Invalid delegated run archive ${label}.`);
  return value;
};
const dispatchKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new Error('Invalid delegated run archive dispatch key.');
  return value;
};
const sha = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid delegated run archive ${label}.`);
  return value;
};
const oid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Invalid delegated run archive receipt.');
  return value;
};
const stamp = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) throw new Error('Invalid delegated run archive timestamp.');
  return value;
};
const exact = (value: Record<string, unknown>, keys: string[], label = 'fields') => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`Invalid delegated run archive ${label}.`);
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid delegated run archive ${label}.`);
  return value as Record<string, unknown>;
};

/** Canonical serialization keeps hashes stable across object insertion order and restarts. */
export function canonicalDelegationRunArchiveJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid delegated run archive number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalDelegationRunArchiveJson).join(',')}]`;
  const record = object(value, 'value');
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalDelegationRunArchiveJson(record[key])}`).join(',')}}`;
}
export function hashDelegationRunArchive(value: Omit<DelegationRunArchive, 'sha256'>): string {
  return createHash('sha256').update(canonicalDelegationRunArchiveJson(value), 'utf8').digest('hex');
}

function receipt(value: unknown): { commit: string; tree: string; baseCommit: string } {
  const input = object(value, 'receipt'); exact(input, ['commit', 'tree', 'baseCommit'], 'receipt');
  return { commit: oid(input.commit), tree: oid(input.tree), baseCommit: oid(input.baseCommit) };
}
function reviewedReceipt(value: unknown): { commit: string; tree: string; baseCommit: string } {
  const input = object(value, 'reviewed receipt');
  return receipt({ commit: input.commit, tree: input.tree, baseCommit: input.baseCommit });
}
function evidenceReference(value: unknown): DelegationRunArchiveEvidenceReference {
  const input = object(value, 'evaluation evidence reference'); exact(input, ['id', 'sha256'], 'evaluation evidence reference');
  if (typeof input.id !== 'string' || !/^[a-f0-9]{24}$/.test(input.id)) throw new Error('Invalid delegated run archive evaluation evidence id.');
  return { id: input.id, sha256: sha(input.sha256, 'evaluation evidence SHA-256') };
}
function recovery(value: unknown, parentId: string, runId: string): DelegationReconciliationProjection {
  const input = object(value, 'recovery state'); exact(input, ['parentId', 'runId', 'availability', 'journal', 'children'], 'recovery state');
  if (taskId(input.parentId, 'recovery parent id') !== parentId || taskId(input.runId, 'recovery run id') !== runId || !['available', 'unavailable'].includes(input.availability as string) || !['available', 'unavailable'].includes(input.journal as string) || !Array.isArray(input.children) || input.children.length > 64) throw new Error('Invalid delegated run archive recovery state.');
  const children = input.children.map(item => {
    const child = object(item, 'recovery child'); exact(child, ['taskId', 'childKey', 'pendingDispatch', 'uncertainWriter', 'cancelled', 'journalRecovery', 'budgetHold', 'restart'], 'recovery child');
    if (typeof child.childKey !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(child.childKey) || !['none', 'interrupted', 'uncertain'].includes(child.restart as string) || ['pendingDispatch', 'uncertainWriter', 'cancelled', 'journalRecovery', 'budgetHold'].some(key => typeof child[key] !== 'boolean')) throw new Error('Invalid delegated run archive recovery child.');
    return { taskId: taskId(child.taskId, 'recovery task id'), childKey: child.childKey, pendingDispatch: child.pendingDispatch as boolean, uncertainWriter: child.uncertainWriter as boolean, cancelled: child.cancelled as boolean, journalRecovery: child.journalRecovery as boolean, budgetHold: child.budgetHold as boolean, restart: child.restart as 'none' | 'interrupted' | 'uncertain' };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (new Set(children.map(item => item.taskId)).size !== children.length) throw new Error('Invalid delegated run archive recovery children.');
  return { parentId, runId, availability: input.availability as 'available' | 'unavailable', journal: input.journal as 'available' | 'unavailable', children };
}

function childArchive(task: Task): DelegationRunArchiveChild {
  const link = task.delegation!;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(link.childKey) || !['claude', 'codex'].includes(task.provider) || !['idle', 'external', 'running', 'interrupted', 'error', 'discarded'].includes(task.state)) throw new Error('Invalid delegated run archive child.');
  const boundaries = (task.delegationResultBoundaries || []).map(boundary => ({ prior: receipt(boundary.prior), replacement: receipt(boundary.replacement), evidenceSha256: createHash('sha256').update(canonicalDelegationRunArchiveJson(boundary.evidence), 'utf8').digest('hex'), archivedAt: stamp(boundary.archivedAt) })).sort((left, right) => `${left.archivedAt}:${left.prior.commit}`.localeCompare(`${right.archivedAt}:${right.prior.commit}`));
  if (boundaries.length > 32) throw new Error('Delegated run archive has too many result boundaries.');
  const boundaryKeys = boundaries.map(boundary => `${boundary.prior.commit}:${boundary.prior.tree}:${boundary.replacement.commit}:${boundary.replacement.tree}`);
  if (boundaries.some(boundary => canonicalDelegationRunArchiveJson(boundary.prior) === canonicalDelegationRunArchiveJson(boundary.replacement)) || new Set(boundaryKeys).size !== boundaryKeys.length) throw new Error('Invalid delegated run archive boundaries.');
  const reviewed = task.reviewedCommit ? reviewedReceipt(task.reviewedCommit) : undefined;
  return { taskId: taskId(task.id, 'child task id'), childKey: link.childKey, dispatchKey: dispatchKey(link.dispatchKey), dependencies: [...link.dependencies].sort(), provider: task.provider, state: task.state, ...(reviewed ? { reviewed } : {}), boundaries };
}

/**
 * Builds a bounded, local review artifact from durable facts only. The allowlist
 * deliberately excludes prompts, titles, handoff text, sessions, provider data,
 * command output, artifact contents, and raw journal events.
 */
export function createDelegationRunArchive(input: DelegationRunArchiveInput): DelegationRunArchive {
  const parentId = taskId(input.parent?.id, 'parent id'), runId = taskId(input.runId, 'run id');
  if (input.parent.delegation || !input.tasks.some(task => task.id === parentId)) throw new Error('Unknown delegated parent run.');
  const children = input.tasks.filter(task => task.delegation?.parentId === parentId && task.delegation.runId === runId).map(childArchive).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (children.length > 64 || new Set(children.map(item => item.taskId)).size !== children.length || new Set(children.map(item => item.dispatchKey)).size !== children.length) throw new Error('Invalid delegated run archive children.');
  const references = (input.evaluationEvidence || []).map(evidenceReference).sort((left, right) => left.id.localeCompare(right.id));
  if (references.length > 256 || new Set(references.map(item => item.id)).size !== references.length) throw new Error('Invalid delegated run archive evaluation evidence.');
  const evaluationEvidence = { availability: input.evaluationEvidence === undefined ? 'unavailable' as const : 'available' as const, references };
  const recoveryState = recovery(input.recovery || { parentId, runId, availability: 'unavailable', journal: 'unavailable', children: [] }, parentId, runId);
  if (new Set(children.map(item => item.childKey)).size !== children.length || children.some(child => child.dependencies.length > 64 || new Set(child.dependencies).size !== child.dependencies.length || child.dependencies.includes(child.taskId) || child.dependencies.some(dependency => !children.some(candidate => candidate.taskId === dependency)))) throw new Error('Invalid delegated run archive dependencies.');
  if (recoveryState.children.some(item => !children.some(child => child.taskId === item.taskId && child.childKey === item.childKey))) throw new Error('Delegated run archive recovery state includes an unknown child.');
  const unsigned = { version: delegationRunArchiveVersion, parentId, runId, children, evaluationEvidence, recovery: recoveryState };
  if (Buffer.byteLength(canonicalDelegationRunArchiveJson(unsigned), 'utf8') > maxDelegationRunArchiveBytes) throw new Error('Delegated run archive exceeds its size bound.');
  const archive = { ...unsigned, sha256: hashDelegationRunArchive(unsigned) };
  if (Buffer.byteLength(JSON.stringify(archive, null, 2), 'utf8') > maxDelegationRunArchiveBytes) throw new Error('Delegated run archive exceeds its size bound.');
  return archive;
}

/** Validates an exported archive. It is intentionally not an import API. */
export function parseDelegationRunArchive(value: unknown): DelegationRunArchive {
  let bytes: number;
  try { bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Buffer.isBuffer(value) ? value.length : Buffer.byteLength(canonicalDelegationRunArchiveJson(value), 'utf8'); }
  catch { throw new Error('Invalid delegated run archive document.'); }
  if (bytes > maxDelegationRunArchiveBytes) throw new Error('Delegated run archive exceeds its size bound.');
  const parsed = typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value) : value;
  const input = object(parsed, 'document'); exact(input, ['version', 'parentId', 'runId', 'children', 'evaluationEvidence', 'recovery', 'sha256'], 'document');
  if (input.version !== delegationRunArchiveVersion || !Array.isArray(input.children)) throw new Error('Invalid delegated run archive document.');
  const parentId = taskId(input.parentId, 'parent id'), runId = taskId(input.runId, 'run id');
  const children = input.children.map(item => {
    const child = object(item, 'child');
    const keys = child.reviewed === undefined ? ['taskId', 'childKey', 'dispatchKey', 'dependencies', 'provider', 'state', 'boundaries'] : ['taskId', 'childKey', 'dispatchKey', 'dependencies', 'provider', 'state', 'reviewed', 'boundaries']; exact(child, keys, 'child');
    if (typeof child.childKey !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(child.childKey) || !Array.isArray(child.dependencies) || child.dependencies.length > 64 || child.dependencies.some(item => typeof item !== 'string' || !/^[a-f0-9]{12}$/.test(item)) || !['claude', 'codex'].includes(child.provider as string) || !['idle', 'external', 'running', 'interrupted', 'error', 'discarded'].includes(child.state as string) || !Array.isArray(child.boundaries)) throw new Error('Invalid delegated run archive child.');
    const boundaries = child.boundaries.map(item => { const boundary = object(item, 'boundary'); exact(boundary, ['prior', 'replacement', 'evidenceSha256', 'archivedAt'], 'boundary'); return { prior: receipt(boundary.prior), replacement: receipt(boundary.replacement), evidenceSha256: sha(boundary.evidenceSha256, 'boundary evidence SHA-256'), archivedAt: stamp(boundary.archivedAt) }; }).sort((left, right) => `${left.archivedAt}:${left.prior.commit}`.localeCompare(`${right.archivedAt}:${right.prior.commit}`));
    if (boundaries.length > 32) throw new Error('Invalid delegated run archive boundaries.');
    const boundaryKeys = boundaries.map(boundary => `${boundary.prior.commit}:${boundary.prior.tree}:${boundary.replacement.commit}:${boundary.replacement.tree}`);
    if (boundaries.some(boundary => canonicalDelegationRunArchiveJson(boundary.prior) === canonicalDelegationRunArchiveJson(boundary.replacement)) || new Set(boundaryKeys).size !== boundaryKeys.length) throw new Error('Invalid delegated run archive boundaries.');
    return { taskId: taskId(child.taskId, 'child task id'), childKey: child.childKey, dispatchKey: dispatchKey(child.dispatchKey), dependencies: [...child.dependencies].sort(), provider: child.provider as 'claude' | 'codex', state: child.state as Task['state'], ...(child.reviewed === undefined ? {} : { reviewed: receipt(child.reviewed) }), boundaries };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  if (children.length > 64 || new Set(children.map(item => item.taskId)).size !== children.length || new Set(children.map(item => item.dispatchKey)).size !== children.length) throw new Error('Invalid delegated run archive children.');
  const evidence = object(input.evaluationEvidence, 'evaluation evidence'); exact(evidence, ['availability', 'references'], 'evaluation evidence');
  if (!['available', 'unavailable'].includes(evidence.availability as string) || !Array.isArray(evidence.references)) throw new Error('Invalid delegated run archive evaluation evidence.');
  const evaluationEvidence = { availability: evidence.availability as 'available' | 'unavailable', references: evidence.references.map(evidenceReference).sort((left, right) => left.id.localeCompare(right.id)) };
  if (evaluationEvidence.references.length > 256 || new Set(evaluationEvidence.references.map(item => item.id)).size !== evaluationEvidence.references.length || (evaluationEvidence.availability === 'unavailable' && evaluationEvidence.references.length)) throw new Error('Invalid delegated run archive evaluation evidence.');
  const archive = { version: delegationRunArchiveVersion, parentId, runId, children, evaluationEvidence, recovery: recovery(input.recovery, parentId, runId) };
  if (new Set(children.map(item => item.childKey)).size !== children.length || children.some(child => child.dependencies.length > 64 || new Set(child.dependencies).size !== child.dependencies.length || child.dependencies.includes(child.taskId) || child.dependencies.some(dependency => !children.some(candidate => candidate.taskId === dependency)))) throw new Error('Invalid delegated run archive dependencies.');
  if (archive.recovery.children.some(item => !children.some(child => child.taskId === item.taskId && child.childKey === item.childKey))) throw new Error('Delegated run archive recovery state includes an unknown child.');
  if (Buffer.byteLength(canonicalDelegationRunArchiveJson(archive), 'utf8') > maxDelegationRunArchiveBytes) throw new Error('Delegated run archive exceeds its size bound.');
  const declaredHash = sha(input.sha256, 'SHA-256');
  if (hashDelegationRunArchive(archive) !== declaredHash) throw new Error('Delegated run archive hash mismatch.');
  return { ...archive, sha256: declaredHash };
}

/** Archives are review-only records; importing them is deliberately unsupported. */
export function importDelegationRunArchive(): never { throw new Error('Delegated run archive import is not supported.'); }
