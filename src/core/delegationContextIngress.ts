import { type ContextRequestBinding, parseDelegationContextRequest, type DelegationContextRequest } from './delegationContextRequests';
import { DelegationOrchestrationJournal } from './delegationOrchestrationJournal';
import { scopePath } from './delegationContext';

/** A host-observed source identity. Content deliberately never crosses this ingress. */
export interface ObservedContextSource { path: string; revision: string; sha256: string; }
export interface ContextSourceReference { id: string; path: string; revision: string; sha256: string; }
export type ContextIngressRefusal = 'invalid-request' | 'out-of-scope' | 'size-limit' | 'stale-source' | 'conflict';
export type ContextIngressReceipt =
  | { version: 1; request: DelegationContextRequest; status: 'selected'; selected: ContextSourceReference[]; }
  | { version: 1; request?: DelegationContextRequest; status: 'refused'; refusal: ContextIngressRefusal; };
export type ContextIngressPreview =
  | { version: 1; request: DelegationContextRequest; status: 'pending'; }
  | { version: 1; status: 'refused'; refusal: ContextIngressRefusal; };

// Context requests themselves permit up to 48 KiB. Delivery stays smaller so a request cannot
// become a disguised brief or transcript payload at the host boundary.
const maxDeliveryRequestBytes = 12 * 1024;

function refusal(error: unknown): ContextIngressRefusal {
  return error instanceof Error && /outside.*child.*scope/i.test(error.message) ? 'out-of-scope' : 'invalid-request';
}
function references(request: DelegationContextRequest): ContextSourceReference[] {
  return request.requested.map(({ id, path, revision, sha256 }) => ({ id, path, revision, sha256 }));
}
function stale(request: DelegationContextRequest, observed: Readonly<Record<string, ObservedContextSource>>): boolean {
  return request.requested.some(source => {
    const current = observed[source.id];
    if (!current || current.revision !== source.revision || current.sha256 !== source.sha256) return true;
    try { return scopePath(current.path).toLowerCase() !== source.path.toLowerCase(); } catch { return true; }
  });
}

/**
 * Parses the user-visible request only. It neither reads a source, writes the journal, nor invokes a model.
 * Callers use this when opening an inbox or inspecting a request before explicitly supplying it.
 */
export function viewDelegationContextRequest(value: unknown, binding: ContextRequestBinding): ContextIngressPreview {
  try {
    const request = parseDelegationContextRequest(value, binding);
    return { version: 1, request, status: 'pending' };
  } catch (error) {
    return { version: 1, status: 'refused', refusal: refusal(error) };
  }
}

/**
 * Host-only explicit delivery boundary. It durably records the bounded request, then compares
 * caller-supplied source identities and returns references only. It never opens source content.
 */
export async function ingressDelegationContextRequest(
  journal: DelegationOrchestrationJournal,
  value: unknown,
  binding: ContextRequestBinding,
  observed: Readonly<Record<string, ObservedContextSource>>,
): Promise<ContextIngressReceipt> {
  let request: DelegationContextRequest;
  try {
    request = parseDelegationContextRequest(value, binding);
  } catch (error) {
    return { version: 1, status: 'refused', refusal: refusal(error) };
  }

  // Retain the immutable request before any delivery decision; a restart can replay the same receipt.
  let persisted: DelegationContextRequest;
  try {
    persisted = await journal.appendContextRequest(request, binding);
  } catch (error) {
    if (error instanceof Error && /Conflicting context request identity/.test(error.message)) {
      return { version: 1, request, status: 'refused', refusal: 'conflict' };
    }
    throw error;
  }
  if (Buffer.byteLength(JSON.stringify(persisted.requested), 'utf8') > maxDeliveryRequestBytes) {
    return { version: 1, request: persisted, status: 'refused', refusal: 'size-limit' };
  }
  if (stale(persisted, observed)) {
    return { version: 1, request: persisted, status: 'refused', refusal: 'stale-source' };
  }
  return { version: 1, request: persisted, status: 'selected', selected: references(persisted) };
}
