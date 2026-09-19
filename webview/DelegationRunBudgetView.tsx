import React from 'react';
import type { DelegationBudgetReservation, DelegationRunUsageProjection, UsageCoverage } from '../src/core/delegationRunAccounting';
import type { UsageSummary, UsageTotals } from '../src/core/usage';
import './delegation-run-budget-view.css';

export interface ChildRunUsage { childKey: string; usage: UsageSummary; coverage: UsageCoverage }
export interface RunSoftHold { provider: 'claude' | 'codex'; reason: string }

function total(summary: UsageSummary): string {
  const values: UsageTotals[] = [summary.claude, summary.codex].filter((value): value is UsageTotals => !!value);
  if (!values.length) return 'Unavailable';
  return values.reduce((sum, value) => sum + value.input + value.output, 0).toLocaleString();
}

function label(coverage: UsageCoverage): string {
  return coverage === 'available' ? 'Reported coverage available' : coverage === 'partial' ? 'Partial reported coverage' : 'Usage unavailable';
}

/** A read-only view of persisted usage and reservation facts. No provider or budget check runs here. */
export function DelegationRunBudgetView({ run, children, reservations, holds }: {
  run: DelegationRunUsageProjection;
  children: readonly ChildRunUsage[];
  reservations: readonly DelegationBudgetReservation[];
  holds: readonly RunSoftHold[];
}) {
  const pending = reservations.filter(item => item.parentId === run.parentId && item.runId === run.runId);
  return <section className="delegation-run-budget" aria-label={`Reported usage for run ${run.runId}`}>
    <header><span className="section-label">RUN USAGE</span><strong>Reported usage</strong><code>{run.runId}</code></header>
    <p className="run-budget-total"><strong>{total(run.total)}</strong> reported input + output tokens <span>{label(run.coverage)}</span></p>
    <p className="quiet">These are recorded local observations, not an enforced account spending cap, subscription balance, or estimate for queued work. Unknown usage is never counted as zero.</p>
    <div className="run-budget-groups">
      <section aria-label="Run stages"><h4>Parent and stages</h4><ul>{Object.entries(run.stages).map(([stage, data]) => <li key={stage}><span>{stage}</span><strong>{total(data.usage)}</strong><small>{label(data.coverage)}</small></li>)}</ul></section>
      <section aria-label="Child observations"><h4>Child observations</h4>{children.length ? <ul>{children.map(child => <li key={child.childKey}><code>{child.childKey}</code><strong>{total(child.usage)}</strong><small>{label(child.coverage)}</small></li>)}</ul> : <p className="quiet">No child usage is recorded.</p>}<p className="quiet">Shared cumulative provider sessions cannot be divided into exact per-child contributions. The run total deduplicates them.</p></section>
    </div>
    <section aria-label="Pending budget reservations"><h4>Pending reservation</h4>{pending.length ? <ul>{pending.map(item => <li key={item.dispatchKey}><code>{item.dispatchKey}</code> · {item.request} · {item.acquiredAt}</li>)}</ul> : <p className="quiet">None recorded for this run.</p>}</section>
    <section aria-label="Soft budget holds"><h4>Soft hold</h4>{holds.length ? <ul>{holds.map((hold, index) => <li key={`${hold.provider}-${index}`}>{hold.provider}: {hold.reason}</li>)}</ul> : <p className="quiet">No hold is reported.</p>}</section>
  </section>;
}
