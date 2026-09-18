import type { ReviewedCommit, Task } from './model';

export type VerificationStatus = 'passed' | 'failed' | 'interrupted' | 'unavailable' | 'not-applicable';
export interface VerificationArtifact {
  kind: 'log' | 'report' | 'screenshot';
  path: string;
  label: string;
}
export interface VerificationCommand {
  executable: string;
  args: string[];
}
export interface VerificationFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  status: 'open' | 'resolved';
  summary: string;
}
export interface VerificationCheckEvidence {
  id: string;
  required: boolean;
  status: VerificationStatus;
  /** Omitted when no runner was available or this check did not apply. */
  command?: VerificationCommand;
  startedAt?: string;
  finishedAt: string;
  exitCode?: number | null;
  artifacts: VerificationArtifact[];
}
export interface VerificationAttemptEvidence {
  id: string;
  number: number;
  checkedCommit: string;
  checkedTree: string;
  startedAt: string;
  finishedAt: string;
  /** Review findings are retained with the attempt instead of being copied into a parent prompt. */
  findings: VerificationFinding[];
  checks: VerificationCheckEvidence[];
}
export interface DelegatedVerificationEvidence {
  version: 1;
  attempts: VerificationAttemptEvidence[];
}

const oid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
/** Stored timestamps are canonical UTC instants, so lexical ordering is never used as a proxy for time. */
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
/** A portable relative reference uses normalized POSIX separators and no filesystem or URI escape syntax. */
const localPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.includes(':')) return false;
  return value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
};
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const command = (value: unknown): value is VerificationCommand => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { executable?: unknown; args?: unknown };
  return boundedText(candidate.executable, 4096) && Array.isArray(candidate.args) && candidate.args.length <= 128 && candidate.args.every(arg => typeof arg === 'string' && arg.length <= 4000 && !arg.includes('\0'));
};

/** Validates retained, local verification evidence; it never executes a runner. */
export function validateDelegatedVerificationEvidence(value: unknown): asserts value is DelegatedVerificationEvidence {
  const evidence = value as DelegatedVerificationEvidence;
  if (!evidence || typeof evidence !== 'object' || evidence.version !== 1 || !Array.isArray(evidence.attempts) || evidence.attempts.length < 1 || evidence.attempts.length > 2) throw new Error('Invalid delegated verification evidence. Original data has been retained.');
  let previousFinishedAt: number | undefined;
  const attemptIds = new Set<string>();
  const requiredCheckIds = new Set<string>();
  for (let index = 0; index < evidence.attempts.length; index++) {
    const attempt = evidence.attempts[index]!;
    if (!attempt || !/^[a-f0-9]{24}$/.test(attempt.id) || attemptIds.has(attempt.id) || attempt.number !== index + 1 || !oid(attempt.checkedCommit) || !oid(attempt.checkedTree) || !timestamp(attempt.startedAt) || !timestamp(attempt.finishedAt) || !Array.isArray(attempt.findings) || attempt.findings.length > 100 || !Array.isArray(attempt.checks) || attempt.checks.length < 1 || attempt.checks.length > 32) throw new Error('Invalid delegated verification attempt. Original data has been retained.');
    attemptIds.add(attempt.id);
    const startedAt = Date.parse(attempt.startedAt), finishedAt = Date.parse(attempt.finishedAt);
    if (startedAt > finishedAt || (previousFinishedAt !== undefined && startedAt < previousFinishedAt)) throw new Error('Invalid delegated verification retry chronology. Original data has been retained.');
    previousFinishedAt = finishedAt;
    const findingIds = new Set<string>();
    for (const finding of attempt.findings) {
      if (!finding || !boundedText(finding.id, 128) || findingIds.has(finding.id) || !['info', 'warning', 'error'].includes(finding.severity) || !['open', 'resolved'].includes(finding.status) || !boundedText(finding.summary, 8000)) throw new Error('Invalid delegated verification finding. Original data has been retained.');
      findingIds.add(finding.id);
    }
    const ids = new Set<string>();
    for (const check of attempt.checks) {
      if (!check || !boundedText(check.id, 128) || ids.has(check.id) || typeof check.required !== 'boolean' || !['passed', 'failed', 'interrupted', 'unavailable', 'not-applicable'].includes(check.status) || !timestamp(check.finishedAt) || (check.startedAt !== undefined && (!timestamp(check.startedAt) || Date.parse(check.startedAt) > Date.parse(check.finishedAt))) || !Array.isArray(check.artifacts) || check.artifacts.length > 32 || (check.exitCode !== undefined && check.exitCode !== null && !Number.isSafeInteger(check.exitCode))) throw new Error('Invalid delegated verification check. Original data has been retained.');
      ids.add(check.id);
      const checkFinishedAt = Date.parse(check.finishedAt);
      const checkStartedAt = check.startedAt === undefined ? undefined : Date.parse(check.startedAt);
      if (checkFinishedAt < startedAt || checkFinishedAt > finishedAt || (checkStartedAt !== undefined && (checkStartedAt < startedAt || checkStartedAt > finishedAt))) throw new Error('Verification check timestamps fall outside their attempt. Original data has been retained.');
      if (check.command !== undefined && !command(check.command)) throw new Error('Invalid delegated verification command. Original data has been retained.');
      if (['unavailable', 'not-applicable'].includes(check.status) && check.command !== undefined) throw new Error('Unavailable or not-applicable verification checks cannot claim a runner. Original data has been retained.');
      if (!['unavailable', 'not-applicable'].includes(check.status) && check.command === undefined) throw new Error('Verification check is missing its runner. Original data has been retained.');
      if (check.status === 'passed' && check.exitCode !== 0) throw new Error('Passed verification checks require a zero exit status. Original data has been retained.');
      if (check.status === 'failed' && check.exitCode === 0) throw new Error('Failed verification checks cannot report a zero exit status. Original data has been retained.');
      for (const artifact of check.artifacts) if (!artifact || !['log', 'report', 'screenshot'].includes(artifact.kind) || !localPath(artifact.path) || !boundedText(artifact.label, 500)) throw new Error('Invalid delegated verification artifact. Original data has been retained.');
    }
    // A retry re-runs every previously required gate. This schema has no
    // replacement relation, so omitting or making one optional is invalid.
    for (const id of requiredCheckIds) {
      if (!attempt.checks.some(check => check.id === id && check.required)) throw new Error('Delegated verification retry omitted a previously required check. Original data has been retained.');
    }
    for (const check of attempt.checks) if (check.required) requiredCheckIds.add(check.id);
  }
}

function receipt(task: Pick<Task, 'reviewedCommit'>): ReviewedCommit {
  if (!task.reviewedCommit) throw new Error('A reviewed commit is required before delegated verification can be accepted.');
  return task.reviewedCommit;
}

/**
 * Completion gate for a managed delegated child. The final recorded attempt
 * must prove every required check ran successfully on the current review
 * receipt and retained at least one local artifact. An attempt with no
 * required checks is a recorded absence of child-level gates, not a passed
 * verification claim; the normal combined integration acceptance still runs.
 */
export function assertDelegatedVerificationGate(task: Pick<Task, 'delegation' | 'reviewedCommit' | 'verificationEvidence'>): void {
  if (!task.delegation) return;
  const current = receipt(task);
  if (!task.verificationEvidence) throw new Error('Delegated child completion requires retained verification evidence.');
  validateDelegatedVerificationEvidence(task.verificationEvidence);
  const attempt = task.verificationEvidence.attempts.at(-1)!;
  if (attempt.checkedCommit !== current.commit || attempt.checkedTree !== current.tree) throw new Error('Delegated verification evidence is stale for the current reviewed commit. Run required checks again.');
  for (const check of attempt.checks.filter(item => item.required)) {
    if (!check.command || check.status === 'unavailable') throw new Error(`Required verification runner is unavailable: ${check.id}.`);
    if (check.status === 'interrupted') throw new Error(`Required verification was interrupted: ${check.id}.`);
    if (check.status !== 'passed' || check.exitCode !== 0) throw new Error(`Required verification did not pass: ${check.id}.`);
    if (check.artifacts.length === 0) throw new Error(`Required verification evidence is missing artifacts: ${check.id}.`);
  }
}
