import React from 'react';
import './delegation-context-inbox.css';

export type ContextInboxState = 'pending' | 'fulfilled' | 'refused';
export interface ContextInboxBinding { parentId: string; runId: string; childKey: string; }
export interface ContextInboxSource { id: string; path: string; revision: string; scope: string; }
export interface ContextInboxRequest {
  requestKey: string;
  binding: ContextInboxBinding;
  requested: ContextInboxSource[];
  state: ContextInboxState;
  /** A delivery record is transient until host wiring persists an outcome. Journal-only receipts stay pending. */
  fulfillment?: { selected: ContextInboxSource[] };
  refusal?: string;
  sourceAvailability?: 'available' | 'unavailable';
}

export interface ContextInboxSupplyAction extends ContextInboxBinding { requestKey: string; }

function matches(left: ContextInboxBinding, right: ContextInboxBinding): boolean {
  return left.parentId === right.parentId && left.runId === right.runId && left.childKey === right.childKey;
}

function stateLabel(request: ContextInboxRequest): string {
  if (request.state === 'fulfilled' && request.fulfillment) return 'Fulfilled';
  if (request.state === 'refused') return 'Refused';
  return request.sourceAvailability === 'unavailable' ? 'Pending · source unavailable' : 'Pending';
}

/**
 * Pure focused-workspace surface. It renders already-recorded request facts only;
 * opening it performs no source read, host ingress, process, or provider action.
 */
export function DelegationContextInbox({ binding, requests, onSupply }: {
  binding: ContextInboxBinding;
  requests: ContextInboxRequest[];
  onSupply?: (action: ContextInboxSupplyAction) => void;
}) {
  const visible = requests.filter(request => matches(request.binding, binding));
  return <section className="delegation-context-inbox" aria-label={`Context requests for ${binding.childKey} in run ${binding.runId}`}>
    <header className="delegation-context-inbox-header">
      <div><span className="section-label">CONTEXT REQUESTS</span><strong>{binding.childKey}</strong></div>
      <code title={`Parent ${binding.parentId}; run ${binding.runId}`}>run {binding.runId}</code>
    </header>
    <p className="delegation-context-inbox-note">Opening this inbox only shows recorded request metadata. It does not read a source or start work.</p>
    {visible.length === 0 ? <p className="delegation-context-inbox-empty">No context requests are recorded for this child in this run.</p> : <ol className="delegation-context-request-list">
      {visible.map(request => {
        const current = matches(request.binding, binding);
        // Feature 22 persists the request, not a delivery result. A snapshot that has lost
        // its live fulfillment record must return to pending after restart.
        const state: ContextInboxState = request.state === 'fulfilled' && !request.fulfillment ? 'pending' : request.state;
        const shown = state === request.state ? request : { ...request, state };
        const canSupply = state === 'pending' && request.sourceAvailability !== 'unavailable' && current && !!onSupply;
        return <li key={request.requestKey} className={`delegation-context-request delegation-context-${state}`}>
          <header><code>{request.requestKey}</code><span className="delegation-context-request-state" role="status">{stateLabel(request)}</span></header>
          <ul aria-label={`Requested sources for ${request.requestKey}`}>
            {request.requested.map(source => <li key={source.id}><code title={source.path}>{source.path}</code><span>revision {source.revision.slice(0, 12)}</span><span>scope {source.scope}</span></li>)}
          </ul>
          {state === 'fulfilled' && <p className="delegation-context-request-detail">{shown.fulfillment!.selected.length} source reference{shown.fulfillment!.selected.length === 1 ? '' : 's'} selected.</p>}
          {state === 'refused' && <p className="delegation-context-request-detail" role="status">Refusal: {request.refusal || 'Unavailable'}</p>}
          {request.sourceAvailability === 'unavailable' && state === 'pending' && <p className="delegation-context-request-detail" role="status">The requested source is unavailable. Supplying context is disabled.</p>}
          {state === 'pending' && <button className="secondary delegation-context-supply" type="button" disabled={!canSupply} onClick={() => onSupply?.({ ...binding, requestKey: request.requestKey })}>Supply selected context</button>}
        </li>;
      })}
    </ol>}
  </section>;
}
