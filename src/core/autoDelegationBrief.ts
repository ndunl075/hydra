import { assertFreshContext, buildChildContext, digest, type ChildContext, type ContextManifest, type ContextPolicy } from './delegationContext';

/**
 * An untrusted proposal for a durable host approval receipt. Its fields are provenance claims,
 * not authority. A host verifier must validate the receipt before it enters a child brief.
 */
export interface AutoDelegationSourceReceipt {
  version: 1;
  id: string;
  path: string;
  revision: string;
  sha256: string;
  kind: 'repository-excerpt' | 'dependency-result';
  approvalReceipt: string;
}

/**
 * Host-owned authority for checking a receipt against durable approval state or a host signing
 * key. This must be supplied by the host integration; callers must never implement it from
 * model-provided receipt fields.
 */
export interface AutoDelegationBriefAuthority {
  verifySourceReceipt(receipt: AutoDelegationSourceReceipt): boolean;
}

export interface AutoDelegationBriefInput {
  child: Omit<ChildContext, 'contextRefs'>;
  context: ContextPolicy;
  /** Receipt proposals for evidence; each is accepted only by `authority`. */
  selectedSources: AutoDelegationSourceReceipt[];
}

export interface AutoDelegationBrief {
  version: 1;
  manifest: ContextManifest;
  selectedSources: AutoDelegationSourceReceipt[];
  display: {
    parentId: string; runId: string; childKey: string; goal: string; baseCommit: string;
    writeScope: string[]; dependencies: string[]; acceptance: string[];
  };
  sha256: string;
}

export type CurrentDelegationSources = Record<string, { revision: string; sha256: string }>;

const sensitiveValue = /(?:\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\b\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b)/i;
const transcriptCopy = /(?:parent|sibling)[_ -]?(?:conversation|history|transcript)/i;

function stablePayload(brief: Omit<AutoDelegationBrief, 'sha256'>): string {
  return JSON.stringify(brief);
}

function assertNoSensitiveValues(manifest: ContextManifest): void {
  if (sensitiveValue.test(manifest.prompt)) throw new Error('The child brief contains a secret value. Select redacted source references before dispatch.');
  if (transcriptCopy.test(manifest.prompt)) throw new Error('The child brief contains parent or sibling transcript content. Select focused source references instead.');
}

function parseSourceReceipt(value: unknown): AutoDelegationSourceReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Child source approval is missing or invalid.');
  const item = value as Record<string, unknown>, keys = ['version', 'id', 'path', 'revision', 'sha256', 'kind', 'approvalReceipt'];
  if (Object.keys(item).some(key => !keys.includes(key)) || Object.keys(item).length !== keys.length || item.version !== 1 || typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || typeof item.path !== 'string' || !item.path || typeof item.revision !== 'string' || !/^[a-f0-9]{40}$/.test(item.revision) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !['repository-excerpt', 'dependency-result'].includes(item.kind as string) || typeof item.approvalReceipt !== 'string' || !item.approvalReceipt) throw new Error('Child source approval is missing or invalid.');
  return item as unknown as AutoDelegationSourceReceipt;
}

function assertApprovedSources(manifest: ContextManifest, values: unknown, authority: AutoDelegationBriefAuthority): AutoDelegationSourceReceipt[] {
  if (!Array.isArray(values) || values.length !== manifest.evidence.length) throw new Error('Every selected child source requires host approval.');
  if (!authority || typeof authority.verifySourceReceipt !== 'function') throw new Error('Host source approval authority is required.');
  const approvals = values.map(parseSourceReceipt);
  if (new Set(approvals.map(source => source.id)).size !== approvals.length) throw new Error('Duplicate child source approval.');
  for (const source of manifest.evidence) {
    const approval = approvals.find(candidate => candidate.id === source.id);
    if (!approval || approval.path !== source.path || approval.revision !== source.revision || approval.sha256 !== source.sha256) throw new Error('Child source approval does not match selected evidence.');
    let verified = false;
    try { verified = authority.verifySourceReceipt(structuredClone(approval)) === true; } catch { /* fail closed */ }
    if (!verified) throw new Error('Child source approval was not verified by host authority.');
  }
  return structuredClone(approvals);
}

/**
 * Produces a deterministic, inspectable brief from host-approved context only. It never reads
 * transcripts, files, credentials, or provider state, and it never creates a worktree or turn.
 */
export function prepareAutoDelegationBrief(input: AutoDelegationBriefInput, authority: AutoDelegationBriefAuthority): AutoDelegationBrief {
  if (!Array.isArray(input.selectedSources)) throw new Error('Every selected child source requires host approval.');
  const selectedSourceRefs = input.selectedSources.map(source => parseSourceReceipt(source).id);
  const manifest = buildChildContext({ ...input.child, contextRefs: selectedSourceRefs }, input.context);
  const selectedSources = assertApprovedSources(manifest, input.selectedSources, authority);
  assertNoSensitiveValues(manifest);
  const display = {
    parentId: manifest.child.parentId, runId: manifest.child.runId, childKey: manifest.child.key,
    goal: manifest.child.goal, baseCommit: manifest.child.baseCommit,
    writeScope: structuredClone(manifest.child.writeScope), dependencies: structuredClone(manifest.child.dependencies),
    acceptance: structuredClone(manifest.child.acceptance)
  };
  const result = { version: 1 as const, manifest, selectedSources, display };
  return { ...result, sha256: digest(stablePayload(result)) };
}

/**
 * Verifies the sealed brief and all included source revisions immediately before a caller hands
 * its prompt to an existing dispatch path. The caller owns all side effects after this return.
 */
export function assertAutoDelegationBriefFresh(brief: AutoDelegationBrief, current: CurrentDelegationSources, authority: AutoDelegationBriefAuthority): void {
  const { sha256, ...payload } = brief;
  if (brief.version !== 1 || digest(stablePayload(payload)) !== sha256) throw new Error('Delegation brief changed. Prepare it again.');
  assertApprovedSources(brief.manifest, brief.selectedSources, authority);
  assertNoSensitiveValues(brief.manifest);
  assertFreshContext(brief.manifest, current);
}

/** Returns the exact already-inspected prompt only after freshness succeeds; it performs no dispatch itself. */
export function dispatchAutoDelegationBrief(brief: AutoDelegationBrief, current: CurrentDelegationSources, authority: AutoDelegationBriefAuthority): string {
  assertAutoDelegationBriefFresh(brief, current, authority);
  return brief.manifest.prompt;
}
