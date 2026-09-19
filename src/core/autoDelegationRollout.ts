import type { DelegationEvaluationReport, EvaluationDecision } from './delegationEvaluationReport';
import type { Provider } from './model';

export type ProviderAcceptanceState = 'accepted' | 'missing' | 'failed';
export type AutoDelegationRolloutDecision = EvaluationDecision;

export interface ProviderAcceptanceFacts {
  claude?: ProviderAcceptanceState;
  codex?: ProviderAcceptanceState;
}

export interface AutoDelegationRolloutInput {
  evaluation: DelegationEvaluationReport;
  providerAcceptance: ProviderAcceptanceFacts;
}

export interface AutoDelegationRolloutAssessment {
  decision: AutoDelegationRolloutDecision;
  reason?: string;
  /** The policy is advisory only. It never changes Hydra's Solo default. */
  defaultMode: 'solo';
}

const advertisedProviders: readonly Provider[] = ['claude', 'codex'];

/**
 * Pure, fail-closed rollout policy over already-supplied local facts. It never
 * reads preferences, starts a provider, or changes the Solo default.
 */
export function assessAutoDelegationRollout(input: AutoDelegationRolloutInput): AutoDelegationRolloutAssessment {
  const { evaluation, providerAcceptance } = input;
  const solo = (decision: AutoDelegationRolloutDecision, reason: string): AutoDelegationRolloutAssessment => ({ decision, reason, defaultMode: 'solo' });

  if (evaluation.decision === 'insufficient') return solo('insufficient', evaluation.reason || 'The paired evaluation evidence is insufficient.');
  if (evaluation.decision === 'keep-solo') return solo('keep-solo', evaluation.reason || 'The paired evaluation requires Solo to remain the default.');

  if (evaluation.sampleCount < evaluation.requiredSamples || evaluation.pairs.length < evaluation.requiredSamples || evaluation.pairs.some(pair => !pair.eligible)) {
    return solo('insufficient', 'The eligible evaluation report lacks complete matching sample evidence.');
  }
  if (evaluation.pairs.some(pair => pair.tokenEfficiency === 'unavailable' || pair.tokenEfficiency === 'partial')) {
    return solo('insufficient', 'Reported usage is missing or partial, so token efficiency is not established.');
  }
  if (evaluation.pairs.some(pair => pair.tokenEfficiency === 'worse' || pair.tradeoff === 'faster-but-more-expensive')) {
    return solo('keep-solo', 'A faster Auto result that costs more is a tradeoff, not rollout evidence.');
  }

  const failed = advertisedProviders.filter(provider => providerAcceptance[provider] === 'failed');
  if (failed.length) return solo('keep-solo', `Provider-specific live acceptance failed for ${failed.join(', ')}.`);
  const missing = advertisedProviders.filter(provider => providerAcceptance[provider] !== 'accepted');
  if (missing.length) return solo('insufficient', `Provider-specific live acceptance is missing for ${missing.join(', ')}.`);

  return { decision: 'eligible-for-human-rollout-review', defaultMode: 'solo' };
}
