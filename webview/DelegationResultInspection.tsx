import React, { useState } from 'react';
import type { DelegationResultReceipt } from '../src/core/delegationResults';
import type { FocusedVerification } from '../src/core/focusedWorkspace';
import './delegation-result-inspection.css';

export interface ResultInspectionIdentity {
  parentId: string;
  runId: string;
  childKey: string;
}

export type IntegrationAcceptance = 'not-reviewed' | 'review-pending' | 'accepted';

export interface DelegationResultInspectionProps {
  /** The selected child identity comes from the focused-workspace selection. */
  identity: ResultInspectionIdentity;
  /** A compact, durable child receipt. It deliberately contains no output bodies. */
  result?: DelegationResultReceipt;
  /** Read-only verification projection for the selected child. */
  verification?: FocusedVerification;
  /** Host-owned combined integration state; child verification never implies this. */
  integration?: IntegrationAcceptance;
  onReview?: (decision: 'approved' | 'rejected', reason: string) => void;
}

type InspectionState = 'missing' | 'blocked' | 'verified';

function matches(result: DelegationResultReceipt, identity: ResultInspectionIdentity): boolean {
  return result.parentId === identity.parentId && result.runId === identity.runId && result.childKey === identity.childKey;
}

/**
 * Computes display-only status for one selected child.  It is intentionally
 * conservative: stale, absent, or malformed snapshot evidence cannot become
 * a verified child result in the UI.
 */
export function resultInspectionState(result: DelegationResultReceipt | undefined, verification: FocusedVerification | undefined, identity: ResultInspectionIdentity): InspectionState {
  if (!result || !matches(result, identity)) return 'missing';
  const lastAttempt = verification?.attempts.at(-1);
  if (verification?.state !== 'passed' || !lastAttempt || lastAttempt.checkedCommit !== result.commit || lastAttempt.checkedTree !== result.tree) return 'blocked';
  return 'verified';
}

const verificationLabel: Record<InspectionState, string> = {
  missing: 'Blocked — result or evidence is unavailable',
  blocked: 'Blocked — evidence is missing or stale',
  verified: 'Verified child result'
};

const integrationLabel: Record<IntegrationAcceptance, string> = {
  'not-reviewed': 'Not accepted for integration',
  'review-pending': 'Integration review pending',
  accepted: 'Accepted integration'
};

/** Presentation-only child result surface. It has no opener, command, or message handler. */
export function DelegationResultInspection({ identity, result, verification, integration = 'not-reviewed', onReview }: DelegationResultInspectionProps) {
  const [reason, setReason] = useState('');
  const state = resultInspectionState(result, verification, identity);
  const selectedResult = result && matches(result, identity) ? result : undefined;
  const execution = selectedResult ? 'Execution complete' : 'Execution not recorded';
  return <section className={`delegation-result-inspection result-${state}`} aria-label={`Delegated result for ${identity.childKey}`}>
    <header>
      <span className="section-label">CHILD RESULT</span>
      <strong><code>{identity.childKey}</code></strong>
      <span className={`result-state result-${state}`}>{verificationLabel[state]}</span>
    </header>
    <p className="result-stages"><span>{execution}</span><span>{verificationLabel[state]}</span><span className={integration === 'accepted' ? 'integration-accepted' : ''}>{integrationLabel[integration]}</span></p>
    {!selectedResult ? <p className="result-blocker">No result receipt is available for this selected child. A receipt from another child or run is not shown here.</p> : <>
      <dl className="result-identity">
        <div><dt>Reviewed commit</dt><dd><code title={selectedResult.commit}>{selectedResult.commit}</code></dd></div>
        <div><dt>Reviewed tree</dt><dd><code title={selectedResult.tree}>{selectedResult.tree}</code></dd></div>
      </dl>
      {state === 'blocked' && <p className="result-blocker">This completed child cannot be used as a verified result until current evidence matches this reviewed commit and tree.</p>}
      <p className="result-summary">{selectedResult.summary}</p>
      <dl className="result-text"><div><dt>Decisions</dt><dd>{selectedResult.decisions}</dd></div></dl>
      <section aria-label="Changed paths"><h4>Changed paths</h4>{selectedResult.changedPaths.length ? <ul>{selectedResult.changedPaths.map(path => <li key={path}><code>{path}</code></li>)}</ul> : <p className="quiet">No changed paths were recorded.</p>}</section>
      <section aria-label="Unresolved issues"><h4>Unresolved issues</h4>{selectedResult.unresolved.length ? <ul>{selectedResult.unresolved.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p className="quiet">No unresolved issues were recorded.</p>}</section>
      <section aria-label="Verification state"><h4>Verification</h4><p>{verificationLabel[state]}</p>{selectedResult.validations.length ? <ul className="result-validations">{selectedResult.validations.map(validation => <li key={validation.command}><span className={`validation-${validation.status}`}>{validation.status}</span><code>{validation.command}</code></li>)}</ul> : <p className="quiet">No child validation summary was recorded.</p>}</section>
      <section aria-label="Evidence references"><h4>Evidence references</h4>{selectedResult.evidence.length ? <ul className="result-evidence">{selectedResult.evidence.map(reference => <li key={reference.id}><span>{reference.kind}</span><strong>{reference.label}</strong><code>{reference.id}</code></li>)}</ul> : <p className="quiet">No evidence references were recorded.</p>}<p className="quiet">References are retained locally. Opening this view does not open artifacts, copy logs or transcripts, run checks, start a process, or submit a model request.</p></section>
      {onReview && <section aria-label="Explicit parent review"><h4>Parent review</h4><label>Concise review reason<textarea maxLength={1200} value={reason} onChange={event => setReason(event.target.value)} /></label><p className="quiet">This records an explicit human decision against the host's current durable result and evidence.</p><button className="secondary" disabled={state !== 'verified' || !reason.trim()} onClick={() => onReview('approved', reason)}>Approve child result</button><button className="secondary" disabled={state !== 'verified' || !reason.trim()} onClick={() => onReview('rejected', reason)}>Reject child result</button></section>}
    </>}
  </section>;
}
