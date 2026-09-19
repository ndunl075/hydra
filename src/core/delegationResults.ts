import { digest, id, key, record, scopePath, text } from './delegationContext';

export interface ResultReceiptBinding {
  parentId: string; runId: string; childKey: string; dispatchKey: string; baseCommit: string; writeScope: string[];
  dependencies: { childKey: string; receiptSha256: string }[];
}
export interface ResultEvidenceReference { id: string; kind: 'log' | 'test' | 'review' | 'screenshot' | 'artifact'; label: string; path: string; sha256: string }
export interface ResultValidation { command: string; status: 'passed' | 'failed' | 'interrupted' | 'unavailable'; evidenceRefs: string[] }
export interface DelegationResultReceipt {
  version: 1; parentId: string; runId: string; childKey: string; dispatchKey: string; baseCommit: string; commit: string; tree: string;
  changedPaths: string[]; decisions: string; summary: string; unresolved: string[]; validations: ResultValidation[];
  evidence: ResultEvidenceReference[]; dependencies: { childKey: string; receiptSha256: string }[]; sha256: string;
}
const maxEvidence = 32, maxValidations = 32, maxBytes = 64 * 1024;
function receiptText(value: unknown, limit: number, name: string): string {
  const result = text(value, limit, name);
  if (/[\r\n\x1b`]/.test(result) || /\b(?:tap version \d+|# subtest:|assertionerror|stack trace|npm err!|stdout:|stderr:|\{\s*"role"\s*:|\[?(?:user|assistant|system)\]?\s*:)/i.test(result)) throw new Error(`Delegated result ${name} must be a concise summary, not transcript or log content.`);
  return result;
}
function objectHash(value: unknown, name: string, length = 64): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) throw new Error(`Invalid delegated result ${name}.`);
  return value;
}
function gitObject(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`Invalid delegated result ${name}.`);
  return value;
}
function scopes(value: string[]): string[] {
  const parsed = value.map(scopePath);
  if (!parsed.length || parsed.length > 32 || new Set(parsed.map(item => item.toLowerCase())).size !== parsed.length) throw new Error('Invalid delegated result binding.');
  return parsed;
}
function inScope(path: string, allowed: string[]): boolean {
  const candidate = scopePath(path).toLowerCase();
  return allowed.some(scope => { const root = scope.replace(/\/$/, '').toLowerCase(); return candidate === root || candidate.startsWith(`${root}/`); });
}
function dependencyList(value: unknown): { childKey: string; receiptSha256: string }[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid delegated result dependencies.');
  const dependencies = value.map(entry => { const item = record(entry, ['childKey', 'receiptSha256']); return { childKey: key(item.childKey), receiptSha256: objectHash(item.receiptSha256, 'dependency receipt') }; });
  if (new Set(dependencies.map(item => item.childKey)).size !== dependencies.length) throw new Error('Duplicate delegated result dependency.');
  return dependencies;
}
function parseEvidence(value: unknown): ResultEvidenceReference[] {
  if (!Array.isArray(value) || value.length > maxEvidence) throw new Error('Invalid delegated result evidence.');
  const evidence = value.map(entry => { const item = record(entry, ['id', 'kind', 'label', 'path', 'sha256']); if (!['log', 'test', 'review', 'screenshot', 'artifact'].includes(item.kind as string)) throw new Error('Invalid delegated result evidence kind.'); return { id: key(item.id), kind: item.kind as ResultEvidenceReference['kind'], label: text(item.label, 300, 'evidence label'), path: scopePath(item.path), sha256: objectHash(item.sha256, 'evidence SHA-256') }; });
  if (new Set(evidence.map(item => item.id)).size !== evidence.length) throw new Error('Duplicate delegated result evidence.');
  return evidence;
}
function parseValidations(value: unknown, evidence: ResultEvidenceReference[]): ResultValidation[] {
  if (!Array.isArray(value) || value.length > maxValidations) throw new Error('Invalid delegated result validations.');
  const valid = new Set(evidence.map(item => item.id));
  const validations = value.map(entry => { const item = record(entry, ['command', 'status', 'evidenceRefs']); const evidenceRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(key) : []; if (!['passed', 'failed', 'interrupted', 'unavailable'].includes(item.status as string) || new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some(ref => !valid.has(ref))) throw new Error('Invalid delegated result validation.'); return { command: text(item.command, 2000, 'validation command'), status: item.status as ResultValidation['status'], evidenceRefs }; });
  if (new Set(validations.map(item => item.command)).size !== validations.length) throw new Error('Duplicate delegated result validation.');
  return validations;
}
function fingerprint(value: Omit<DelegationResultReceipt, 'sha256'>): string { return digest(JSON.stringify(value)); }

/** Parses a compact child receipt; complete logs are represented by references and never copied into this contract. */
export function prepareDelegationResult(value: unknown, input: ResultReceiptBinding): DelegationResultReceipt {
  const owner = { parentId: id(input.parentId), runId: id(input.runId), childKey: key(input.childKey), dispatchKey: objectHash(input.dispatchKey, 'dispatch key', 24), baseCommit: gitObject(input.baseCommit, 'base commit'), writeScope: scopes(input.writeScope), dependencies: dependencyList(input.dependencies) };
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'dispatchKey', 'baseCommit', 'commit', 'tree', 'changedPaths', 'decisions', 'summary', 'unresolved', 'validations', 'evidence', 'dependencies']);
  if (item.version !== 1 || item.parentId !== owner.parentId || item.runId !== owner.runId || item.childKey !== owner.childKey || item.dispatchKey !== owner.dispatchKey || item.baseCommit !== owner.baseCommit) throw new Error('Result receipt belongs to a different delegated child or run.');
  if (!Array.isArray(item.changedPaths) || item.changedPaths.length > 256 || !Array.isArray(item.unresolved) || item.unresolved.length > 32) throw new Error('Invalid delegated result paths or unresolved issues.');
  const changedPaths = item.changedPaths.map(scopePath);
  if (new Set(changedPaths.map(path => path.toLowerCase())).size !== changedPaths.length || changedPaths.some(path => !inScope(path, owner.writeScope))) throw new Error('Result receipt changes are outside the child write scope.');
  const evidence = parseEvidence(item.evidence), dependencies = dependencyList(item.dependencies);
  if (JSON.stringify(dependencies) !== JSON.stringify(owner.dependencies)) throw new Error('Result receipt dependencies do not match the recorded child dependencies.');
  const unsigned = { version: 1 as const, parentId: owner.parentId, runId: owner.runId, childKey: owner.childKey, dispatchKey: owner.dispatchKey, baseCommit: owner.baseCommit, commit: gitObject(item.commit, 'commit'), tree: gitObject(item.tree, 'tree'), changedPaths, decisions: receiptText(item.decisions, 1200, 'decisions'), summary: receiptText(item.summary, 1200, 'summary'), unresolved: item.unresolved.map(value => receiptText(value, 500, 'unresolved issue')), validations: parseValidations(item.validations, evidence), evidence, dependencies };
  if (new Set(unsigned.unresolved).size !== unsigned.unresolved.length || Buffer.byteLength(JSON.stringify(unsigned), 'utf8') > maxBytes) throw new Error('Delegated result receipt exceeds its size bound or repeats an issue.');
  return { ...unsigned, sha256: fingerprint(unsigned) };
}
/** Parses a persisted receipt against all recorded host bindings before trusting its hash. */
export function parseDelegationResultReceipt(value: unknown, input: ResultReceiptBinding): DelegationResultReceipt {
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'dispatchKey', 'baseCommit', 'commit', 'tree', 'changedPaths', 'decisions', 'summary', 'unresolved', 'validations', 'evidence', 'dependencies', 'sha256']);
  const expected = objectHash(item.sha256, 'receipt SHA-256');
  const prepared = prepareDelegationResult({ version: item.version, parentId: item.parentId, runId: item.runId, childKey: item.childKey, dispatchKey: item.dispatchKey, baseCommit: item.baseCommit, commit: item.commit, tree: item.tree, changedPaths: item.changedPaths, decisions: item.decisions, summary: item.summary, unresolved: item.unresolved, validations: item.validations, evidence: item.evidence, dependencies: item.dependencies }, input);
  if (prepared.sha256 !== expected) throw new Error('Delegated result receipt changed. Do not deliver it.');
  return prepared;
}
export function assertDelegationResultIntegrity(receipt: unknown, input: ResultReceiptBinding): void {
  parseDelegationResultReceipt(receipt, input);
}
