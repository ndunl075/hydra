import { validateDelegatedVerificationEvidence, type DelegatedVerificationEvidence } from './delegationEvidence';
import type { ReviewedCommit, Task } from './model';

export interface DelegationResultBoundary {
  version: 1;
  /** The reviewed child result that the retained evidence actually checked. */
  prior: Pick<ReviewedCommit, 'commit' | 'tree' | 'baseCommit'>;
  /** The later reviewed result which made that evidence ineligible for acceptance. */
  replacement: Pick<ReviewedCommit, 'commit' | 'tree' | 'baseCommit'>;
  evidence: DelegatedVerificationEvidence;
  archivedAt: string;
}

/** Detached state that a host must durably save before changing its live task. */
export interface DelegatedResultBoundaryArchiveCandidate {
  verificationEvidence: undefined;
  delegationResultBoundaries: DelegationResultBoundary[];
}

type BoundaryTask = Task;
const oid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const sameResult = (left: Pick<ReviewedCommit, 'commit' | 'tree' | 'baseCommit'>, right: Pick<ReviewedCommit, 'commit' | 'tree' | 'baseCommit'>) => left.commit === right.commit && left.tree === right.tree && left.baseCommit === right.baseCommit;
const clone = <T>(value: T): T => structuredClone(value);

function receipt(value: unknown, label: string): asserts value is Pick<ReviewedCommit, 'commit' | 'tree' | 'baseCommit'> {
  const candidate = value as Partial<ReviewedCommit>;
  if (!candidate || typeof candidate !== 'object' || !oid(candidate.commit) || !oid(candidate.tree) || !oid(candidate.baseCommit) || Object.keys(candidate).some(key => !['commit', 'tree', 'baseCommit'].includes(key))) throw new Error(`Invalid delegated result-boundary ${label}. Original data has been retained.`);
}

/** Validates durable archive receipts only; it never re-runs child verification. */
export function validateDelegationResultBoundaries(task: BoundaryTask): void {
  const boundaries = task.delegationResultBoundaries;
  if (boundaries === undefined) return;
  if (!task.delegation || !Array.isArray(boundaries) || boundaries.length > 32) throw new Error('Invalid delegated result-boundary archive. Original data has been retained.');
  const identities = new Map<string, DelegationResultBoundary>();
  for (const boundary of boundaries) {
    if (!boundary || typeof boundary !== 'object' || boundary.version !== 1 || Object.keys(boundary).some(key => !['version', 'prior', 'replacement', 'evidence', 'archivedAt'].includes(key))) throw new Error('Invalid delegated result-boundary archive. Original data has been retained.');
    receipt(boundary.prior, 'prior receipt'); receipt(boundary.replacement, 'replacement receipt');
    if (!timestamp(boundary.archivedAt) || sameResult(boundary.prior, boundary.replacement)) throw new Error('Invalid delegated result-boundary archive. Original data has been retained.');
    validateDelegatedVerificationEvidence(boundary.evidence);
    const checked = boundary.evidence.attempts.at(-1)!;
    if (checked.checkedCommit !== boundary.prior.commit || checked.checkedTree !== boundary.prior.tree) throw new Error('Delegated result-boundary evidence does not match its preserved receipt. Original data has been retained.');
    const key = `${boundary.prior.commit}:${boundary.prior.tree}:${boundary.replacement.commit}:${boundary.replacement.tree}`;
    const previous = identities.get(key);
    if (previous && JSON.stringify(previous.evidence) !== JSON.stringify(boundary.evidence)) throw new Error('Conflicting delegated result-boundary identities. Original data has been retained.');
    if (previous) throw new Error('Duplicate delegated result-boundary identity. Original data has been retained.');
    identities.set(key, boundary);
  }
}

/**
 * Builds a detached archive transition. This has no live-task side effects and
 * gives a host the exact fields it must include in its durable task save.
 */
export function prepareSupersededDelegatedResultArchive(task: BoundaryTask, evidence = task.verificationEvidence, archivedAt = new Date().toISOString()): DelegatedResultBoundaryArchiveCandidate {
  if (!task.delegation) throw new Error('Only delegated child results can be archived.');
  if (!task.reviewedCommit || !evidence) throw new Error('A reviewed child result and its verification evidence are required to create a result boundary.');
  validateDelegatedVerificationEvidence(evidence);
  if (!timestamp(archivedAt)) throw new Error('Invalid delegated result-boundary archive timestamp.');
  const checked = evidence.attempts.at(-1)!;
  const prior = { commit: checked.checkedCommit, tree: checked.checkedTree, baseCommit: task.reviewedCommit.baseCommit };
  const replacement = { commit: task.reviewedCommit.commit, tree: task.reviewedCommit.tree, baseCommit: task.reviewedCommit.baseCommit };
  if (sameResult(prior, replacement)) throw new Error('A delegated result boundary requires a changed reviewed commit or tree.');
  const boundary: DelegationResultBoundary = { version: 1, prior, replacement, evidence: clone(evidence), archivedAt };
  validateDelegationResultBoundaries(task);
  const existing = task.delegationResultBoundaries || [];
  const sameIdentity = existing.find(boundary => sameResult(boundary.prior, prior) && sameResult(boundary.replacement, replacement));
  if (sameIdentity) {
    if (JSON.stringify(sameIdentity.evidence) !== JSON.stringify(boundary.evidence)) throw new Error('Conflicting delegated result-boundary identities.');
    const candidate = { verificationEvidence: undefined, delegationResultBoundaries: clone(existing) };
    validateDelegationResultBoundaries({ ...task, ...candidate });
    return candidate;
  }
  if (existing.some(boundary => sameResult(boundary.prior, prior))) throw new Error('Conflicting delegated result-boundary identities.');
  const candidate = { verificationEvidence: undefined, delegationResultBoundaries: [...clone(existing), boundary] };
  validateDelegationResultBoundaries({ ...task, ...candidate });
  return candidate;
}
