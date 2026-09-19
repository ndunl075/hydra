import { digest, id, key, record, scopePath, text } from './delegationContext';

export interface ContextRequestBinding {
  parentId: string; runId: string; childKey: string; writeScope: string[];
  /** Host-authorized readable locations. Omit to restrict requests to writeScope. */
  readScope?: string[];
}
export interface RequestedContext {
  id: string; path: string; revision: string; sha256: string; reason: string;
}
export interface DelegationContextRequest {
  version: 1; parentId: string; runId: string; childKey: string; requestKey: string;
  requested: RequestedContext[]; sha256: string;
}
const maxRequested = 16, maxTotalBytes = 48 * 1024;
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Invalid requested context revision.');
  return value;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid requested context ${name}.`);
  return value;
}
function withinScope(path: string, scopes: string[]): boolean {
  const candidate = scopePath(path).toLowerCase();
  return scopes.some(scope => {
    const allowed = scopePath(scope).replace(/\/$/, '').toLowerCase();
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
  });
}
function parseRequested(value: unknown, scopes: string[]): RequestedContext[] {
  if (!Array.isArray(value) || !value.length || value.length > maxRequested) throw new Error('Invalid requested context list.');
  const requested = value.map(entry => {
    const item = record(entry, ['id', 'path', 'revision', 'sha256', 'reason']);
    const path = scopePath(item.path);
    if (!withinScope(path, scopes)) throw new Error('Requested context is outside the child write scope.');
    return { id: key(item.id), path, revision: revision(item.revision), sha256: hash(item.sha256, 'SHA-256'), reason: text(item.reason, 1000, 'reason') };
  });
  if (new Set(requested.map(item => item.id)).size !== requested.length || new Set(requested.map(item => item.path.toLowerCase())).size !== requested.length) throw new Error('Duplicate requested context.');
  if (Buffer.byteLength(JSON.stringify(requested), 'utf8') > maxTotalBytes) throw new Error('Requested context exceeds its size bound.');
  return requested;
}
function scopes(value: string[]): string[] {
  const parsed = value.map(scopePath);
  if (!parsed.length || parsed.length > 32 || new Set(parsed.map(item => item.toLowerCase())).size !== parsed.length) throw new Error('Invalid child context request binding.');
  return parsed;
}
function binding(input: ContextRequestBinding): Required<ContextRequestBinding> {
  const writeScope = input.writeScope.map(scopePath);
  const readScope = input.readScope === undefined ? writeScope : scopes(input.readScope);
  if (!writeScope.length || writeScope.length > 32 || new Set(writeScope.map(item => item.toLowerCase())).size !== writeScope.length) throw new Error('Invalid child context request binding.');
  return { parentId: id(input.parentId), runId: id(input.runId), childKey: key(input.childKey), writeScope, readScope };
}
function fingerprint(value: Omit<DelegationContextRequest, 'sha256'>): string { return digest(JSON.stringify(value)); }

/** Creates a bounded, host-bindable request. It does not read files, expand scope, or deliver context. */
export function prepareContextRequest(value: unknown, input: ContextRequestBinding): DelegationContextRequest {
  const owner = binding(input), item = record(value, ['version', 'parentId', 'runId', 'childKey', 'requestKey', 'requested']);
  if (item.version !== 1 || item.parentId !== owner.parentId || item.runId !== owner.runId || item.childKey !== owner.childKey) throw new Error('Context request belongs to a different delegated child or run.');
  if (typeof item.requestKey !== 'string' || !/^[a-f0-9]{24}$/.test(item.requestKey)) throw new Error('Invalid requested context key.');
  const requestKey = item.requestKey;
  const unsigned = { version: 1 as const, parentId: owner.parentId, runId: owner.runId, childKey: owner.childKey, requestKey, requested: parseRequested(item.requested, owner.readScope) };
  return { ...unsigned, sha256: fingerprint(unsigned) };
}
/** Parses a persisted request against the host's original scope binding before trusting its hash. */
export function parseDelegationContextRequest(value: unknown, input: ContextRequestBinding): DelegationContextRequest {
  const item = record(value, ['version', 'parentId', 'runId', 'childKey', 'requestKey', 'requested', 'sha256']);
  const expected = hash(item.sha256, 'receipt SHA-256');
  const prepared = prepareContextRequest({ version: item.version, parentId: item.parentId, runId: item.runId, childKey: item.childKey, requestKey: item.requestKey, requested: item.requested }, input);
  if (prepared.sha256 !== expected) throw new Error('Context request changed. Create it again.');
  return prepared;
}
/** Refuses a request whose host-observed source revision or bytes no longer match its provenance. */
export function assertFreshContextRequest(request: unknown, input: ContextRequestBinding, current: Record<string, { revision: string; sha256: string }>): void {
  const parsed = parseDelegationContextRequest(request, input);
  for (const source of parsed.requested) {
    const observed = current[source.id];
    if (!observed || observed.revision !== source.revision || observed.sha256 !== source.sha256) throw new Error(`Requested context ${source.id} changed or is unavailable.`);
  }
}
