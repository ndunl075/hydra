import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAutoDelegationRollout, type AutoDelegationRolloutInput } from '../src/core/autoDelegationRollout';

const input = (): AutoDelegationRolloutInput => ({
  evaluation: {
    version: 1,
    decision: 'eligible-for-human-rollout-review',
    sampleCount: 1,
    requiredSamples: 1,
    pairs: [{ pairId: 'pair_1', caseId: 'case_1', eligible: true, tokenEfficiency: 'improved' }]
  },
  providerAcceptance: { claude: 'accepted', codex: 'accepted' }
});

test('only complete paired evidence and provider-specific acceptance are eligible for human rollout review', () => {
  const assessment = assessAutoDelegationRollout(input());
  assert.deepEqual(assessment, { decision: 'eligible-for-human-rollout-review', defaultMode: 'solo' });
});

test('missing or partial reported usage fails closed as insufficient even when a supplied report claims eligibility', () => {
  for (const tokenEfficiency of ['unavailable', 'partial'] as const) {
    const value = input();
    value.evaluation.pairs[0]!.tokenEfficiency = tokenEfficiency;
    const assessment = assessAutoDelegationRollout(value);
    assert.equal(assessment.decision, 'insufficient');
    assert.match(assessment.reason || '', /usage/i);
  }
});

test('faster but more expensive samples keep Solo', () => {
  const value = input();
  value.evaluation.pairs[0] = { ...value.evaluation.pairs[0]!, tokenEfficiency: 'worse', tradeoff: 'faster-but-more-expensive' };
  const assessment = assessAutoDelegationRollout(value);
  assert.equal(assessment.decision, 'keep-solo');
  assert.match(assessment.reason || '', /tradeoff/i);
});

test('provider acceptance is required separately for every advertised provider', () => {
  const missing = input();
  delete missing.providerAcceptance.claude;
  assert.equal(assessAutoDelegationRollout(missing).decision, 'insufficient');

  const failed = input();
  failed.providerAcceptance.codex = 'failed';
  assert.equal(assessAutoDelegationRollout(failed).decision, 'keep-solo');
});

test('a non-eligible, incomplete, or Solo evaluation cannot be upgraded by acceptance facts', () => {
  const insufficient = input();
  insufficient.evaluation.decision = 'insufficient';
  assert.equal(assessAutoDelegationRollout(insufficient).decision, 'insufficient');

  const incomplete = input();
  incomplete.evaluation.sampleCount = 0;
  assert.equal(assessAutoDelegationRollout(incomplete).decision, 'insufficient');

  const keepSolo = input();
  keepSolo.evaluation.decision = 'keep-solo';
  assert.equal(assessAutoDelegationRollout(keepSolo).decision, 'keep-solo');
});
