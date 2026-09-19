import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvaluationReportView } from '../webview/EvaluationReport';

test('evaluation report view is read-only and makes insufficient evidence explicit', () => {
  const missing = renderToStaticMarkup(React.createElement(EvaluationReportView)); assert.match(missing, /Evidence unavailable/); assert.match(missing, /does not run a task/); assert.doesNotMatch(missing, /<button/);
  const report = renderToStaticMarkup(React.createElement(EvaluationReportView, { report: { version: 1, decision: 'keep-solo', sampleCount: 1, requiredSamples: 3, reason: 'Auto quality regression blocks rollout review.', pairs: [{ pairId: 'a'.repeat(24), caseId: 'case_one', eligible: false, reason: 'Auto quality regression blocks rollout review.', tokenEfficiency: 'unavailable' }] } }));
  assert.match(report, /Keep Solo/); assert.match(report, /1 \/ 3 matched samples/); assert.doesNotMatch(report, /<button/);
});
