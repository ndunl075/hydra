import React from 'react';
import type { ClientMessage, HelperJobView } from '../src/core/model';
import './helper-dashboard.css';

/**
 * Hydra helpers started by Claude Code or Codex (docs/Official_Extensions_Plan.md,
 * Phase 6): what each one is doing, what it produced, and a way to review, read
 * its log, cancel it, or stop them all.
 */
const stateLabel: Record<string, string> = { queued: 'Queued', starting: 'Starting', running: 'Working', blocked: 'Needs an answer', checking: 'Checking', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const active = (state: string) => ['queued', 'starting', 'running', 'blocked', 'checking'].includes(state);

export function HelperDashboard({ helpers, busy, send }: { helpers: HelperJobView[]; busy: boolean; send: (message: ClientMessage) => void }) {
  if (!helpers.length) return null;
  const running = helpers.filter(helper => active(helper.state)).length;
  return <section className="helper-dashboard" aria-label="Hydra heads">
    <header className="helper-dashboard-header">
      <h2>Heads <span>{running ? `${running} active` : `${helpers.length} finished`}</span></h2>
      {running > 0 && <button className="secondary" disabled={busy} onClick={() => send({ type: 'helperStopAll' })}>Stop all</button>}
    </header>
    <ul className="helper-list">
      {helpers.slice(0, 20).map(helper => <li key={helper.id} className={`helper-row helper-${helper.state}`}>
        <div className="helper-main">
          <span className={`helper-state state-${helper.state}`}>{stateLabel[helper.state] || helper.state}</span>
          <strong className="helper-title" title={helper.title}>{helper.title}</strong>
          <span className="helper-meta">{helper.provider === 'claude' ? 'Claude' : 'Codex'}{helper.branch ? ` · ${helper.branch}` : ''}</span>
        </div>
        {helper.question && <p className="helper-question">Asks: {helper.question} <span>(answer in the chat that started it)</span></p>}
        {!helper.question && helper.progress && active(helper.state) && <p className="helper-note">{helper.progress}</p>}
        {helper.reason && !active(helper.state) && helper.state !== 'done' && <p className="helper-note">{helper.reason}</p>}
        {helper.summary && <p className="helper-note">{helper.summary}</p>}
        {(helper.changedFiles > 0 || helper.checks.length > 0) && <p className="helper-facts">
          {helper.changedFiles > 0 && <span>{helper.changedFiles} file{helper.changedFiles === 1 ? '' : 's'} changed</span>}
          {helper.checks.map(check => <span key={check.id} className={check.passed ? 'check-pass' : 'check-fail'}>{check.passed ? '✓' : '✗'} {check.id}</span>)}
          {helper.commit && <code>{helper.commit.slice(0, 10)}</code>}
        </p>}
        <div className="helper-actions">
          {helper.branch && <button className="text-button" onClick={() => send({ type: 'helperReview', jobId: helper.id })}>Review changes</button>}
          <button className="text-button" onClick={() => send({ type: 'helperLog', jobId: helper.id })}>Open log</button>
          {active(helper.state) && <button className="text-button" disabled={busy} onClick={() => send({ type: 'helperCancel', jobId: helper.id })}>Cancel</button>}
        </div>
      </li>)}
    </ul>
  </section>;
}
