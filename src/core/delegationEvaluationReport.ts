import { parseDelegationEvaluationCorpus, type DelegationEvaluationCorpus } from './delegationEvaluationCorpus';
import { parseDelegationEvaluationObservation, projectDelegationEvaluationLedger, type DelegationEvaluationObservation } from './delegationEvaluationLedger';

export type EvaluationDecision = 'insufficient' | 'keep-solo' | 'eligible-for-human-rollout-review';
export type TokenEfficiency = 'improved' | 'within-tolerance' | 'worse' | 'partial' | 'unavailable';
export interface EvaluationPairReport { pairId: string; caseId: string; eligible: boolean; reason?: string; tokenEfficiency: TokenEfficiency; tradeoff?: 'faster-but-more-expensive'; }
export interface DelegationEvaluationReport { version: 1; decision: EvaluationDecision; sampleCount: number; requiredSamples: number; pairs: EvaluationPairReport[]; reason?: string; }

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const passed = (value: DelegationEvaluationObservation) => value.acceptance === 'passed' && value.regressions.status === 'passed' && value.integrationConflicts.status === 'passed' && value.manualRework.status === 'passed';

/** Pure report over sealed local records. It never loads a ledger, reads artifacts, changes preferences, or invokes a provider. */
export function reportDelegationEvaluation(corpusValue: unknown, recordsValue: unknown[]): DelegationEvaluationReport {
  const corpus = parseDelegationEvaluationCorpus(corpusValue), records = recordsValue.map(value => parseDelegationEvaluationObservation(value, corpus));
  const projections = projectDelegationEvaluationLedger(corpus, records), pairs: EvaluationPairReport[] = [];
  for (const projection of projections) {
    if (!projection.auto || !projection.solo) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Matching Auto and Solo evidence is required.' }); continue; }
    const auto = projection.auto, solo = projection.solo, baseline = corpus.cases.find(item => item.id === projection.caseId)!;
    if (!passed(auto) || !passed(solo)) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Acceptance, regressions, conflicts, and manual rework must be recorded as passed.' }); continue; }
    if (auto.quality.status !== 'passed' || solo.quality.status !== 'passed' || auto.quality.score === undefined || solo.quality.score === undefined) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Quality evidence is unavailable.' }); continue; }
    if (auto.quality.score < baseline.qualityThreshold.minimumScore || auto.quality.score < solo.quality.score - corpus.tolerances.qualityRegressionPoints) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Auto quality regression blocks rollout review.' }); continue; }
    if (auto.elapsedTime.status !== 'passed' || solo.elapsedTime.status !== 'passed' || auto.elapsedTime.milliseconds === undefined || solo.elapsedTime.milliseconds === undefined) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Elapsed-time evidence is unavailable.' }); continue; }
    if (((auto.elapsedTime.milliseconds - solo.elapsedTime.milliseconds) / Math.max(solo.elapsedTime.milliseconds, 1)) * 100 > corpus.tolerances.elapsedTimeIncreasePercent) { pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: false, tokenEfficiency: projection.usageCoverage === 'unavailable' ? 'unavailable' : 'partial', reason: 'Auto exceeded the predeclared elapsed-time tolerance.' }); continue; }
    let tokenEfficiency: TokenEfficiency = projection.usageCoverage === 'unavailable' ? 'unavailable' : projection.usageCoverage === 'partial' ? 'partial' : 'within-tolerance';
    let tradeoff: 'faster-but-more-expensive' | undefined;
    if (projection.usageCoverage === 'available') {
      const autoTokens = auto.reportedUsage.tokens!, soloTokens = solo.reportedUsage.tokens!, increase = ((autoTokens - soloTokens) / Math.max(soloTokens, 1)) * 100;
      tokenEfficiency = increase < 0 ? 'improved' : increase > corpus.tolerances.usageIncreasePercent ? 'worse' : 'within-tolerance';
      if (tokenEfficiency === 'worse' && auto.elapsedTime.milliseconds < solo.elapsedTime.milliseconds) tradeoff = 'faster-but-more-expensive';
    }
    pairs.push({ pairId: projection.pairId, caseId: projection.caseId, eligible: true, tokenEfficiency, ...(tradeoff ? { tradeoff } : {}) });
  }
  const complete = pairs.filter(pair => !pair.reason).length;
  if (pairs.some(pair => /quality regression/i.test(pair.reason || ''))) return { version: 1, decision: 'keep-solo', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'Auto quality regression blocks rollout review.' };
  if (pairs.some(pair => /elapsed-time tolerance/i.test(pair.reason || ''))) return { version: 1, decision: 'keep-solo', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'Auto exceeded the predeclared elapsed-time tolerance.' };
  if (pairs.some(pair => /elapsed-time evidence/i.test(pair.reason || ''))) return { version: 1, decision: 'insufficient', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'Elapsed-time evidence is unavailable.' };
  if (complete < corpus.tolerances.samplesPerMode) return { version: 1, decision: 'insufficient', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'The predeclared matching sample count is not met.' };
  if (pairs.some(pair => pair.reason)) return { version: 1, decision: 'keep-solo', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'At least one matched pair failed a required gate.' };
  if (pairs.some(pair => pair.tokenEfficiency === 'unavailable' || pair.tokenEfficiency === 'partial')) return { version: 1, decision: 'insufficient', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'Reported usage coverage cannot support a token-efficiency conclusion.' };
  if (pairs.some(pair => pair.tokenEfficiency === 'worse')) return { version: 1, decision: 'keep-solo', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs, reason: 'Auto exceeded the predeclared reported-token tolerance.' };
  return { version: 1, decision: 'eligible-for-human-rollout-review', sampleCount: complete, requiredSamples: corpus.tolerances.samplesPerMode, pairs };
}
