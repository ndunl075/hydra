import React from 'react';
import type { DelegationEvaluationReport } from '../src/core/delegationEvaluationReport';

const label: Record<DelegationEvaluationReport['decision'], string> = {
  insufficient: 'More evidence required', 'keep-solo': 'Keep Solo', 'eligible-for-human-rollout-review': 'Ready for human review'
};

/** Presentation-only projection: it sends no messages and never changes the delegation preference. */
export function EvaluationReportView({ report }: { report?: DelegationEvaluationReport }) {
  if (!report) return <section className="evaluation-report" aria-label="Auto versus Solo evaluation"><header><span className="section-label">AUTO / SOLO EVALUATION</span><strong>Evidence unavailable</strong></header><p>Attach sealed paired evidence before a report can be reviewed. Viewing does not run a task, read an artifact, or change Auto mode.</p></section>;
  return <section className={`evaluation-report evaluation-${report.decision}`} aria-label="Auto versus Solo evaluation"><header><span className="section-label">AUTO / SOLO EVALUATION</span><strong>{label[report.decision]}</strong><span>{report.sampleCount} / {report.requiredSamples} matched samples</span></header><p>{report.reason || 'This is evidence for a human rollout review. It does not enable Auto.'}</p><ul>{report.pairs.map(pair => <li key={pair.pairId}><code>{pair.caseId}</code><span>{pair.reason || pair.tokenEfficiency}</span>{pair.tradeoff && <em>{pair.tradeoff.replaceAll('-', ' ')}</em>}</li>)}</ul><p className="quiet">Read-only local projection. No provider request, artifact opening, preference update, or rollout action occurs here.</p></section>;
}
