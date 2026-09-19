import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digest } from '../src/core/delegationContext';
import { reportDelegationEvaluation } from '../src/core/delegationEvaluationReport';

const corpus = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/corpus-v1.json', 'utf8'));
const descriptors = () => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/paired-runs-v1.json', 'utf8'));
const seal = (value: any) => { const { sha256: _hash, ...unsigned } = value; value.sha256 = digest(JSON.stringify(unsigned)); return value; };
const readyCorpus = () => { const value = corpus(); value.tolerances.samplesPerMode = 1; const { sha256: _hash, ...unsigned } = value; value.sha256 = digest(JSON.stringify(unsigned)); return value; };
const record = (mode: 'auto' | 'solo', runId: string, corpusValue: any, pairId = 'aaaaaaaaaaaaaaaaaaaaaaaa') => { const descriptor = descriptors()[mode], baseline = corpusValue.cases.find((item: any) => item.id === descriptor.caseId); descriptor.corpusId = corpusValue.id; descriptor.corpusSha256 = corpusValue.sha256; descriptor.caseSha256 = baseline.caseSha256; return seal({ version: 1, id: mode === 'auto' ? '111111111111111111111111' : '222222222222222222222222', pairId, runId, descriptor, acceptance: 'passed', quality: { status: 'passed', score: 95 }, elapsedTime: { status: 'passed', milliseconds: mode === 'auto' ? 100 : 200 }, reportedUsage: { coverage: 'available', tokens: 100 }, regressions: { status: 'passed', count: 0 }, integrationConflicts: { status: 'passed', count: 0 }, manualRework: { status: 'passed', minutes: 0 }, artifacts: [] }); };
const paired = (corpusValue = corpus()) => [record('auto', '333333333333333333333333', corpusValue), record('solo', '444444444444444444444444', corpusValue)];

test('predeclared samples and exact matching pairs are required', () => {
  const c = corpus(); c.tolerances.samplesPerMode = 2; const { sha256: _hash, ...unsigned } = c; c.sha256 = digest(JSON.stringify(unsigned));
  assert.equal(reportDelegationEvaluation(c, paired(c)).decision, 'insufficient');
  assert.equal(reportDelegationEvaluation(corpus(), [paired()[0]]).decision, 'insufficient');
});
test('quality regression always keeps Solo even when Auto is faster', () => {
  const c = readyCorpus(), values = paired(c); values[0].quality.score = 10; seal(values[0]);
  const report = reportDelegationEvaluation(c, values); assert.equal(report.decision, 'keep-solo'); assert.match(report.pairs[0]!.reason || '', /quality/i);
});
test('materially slower Auto exceeds the predeclared elapsed-time tolerance', () => {
  const c = readyCorpus(), values = paired(c); values[0].elapsedTime.milliseconds = 1000; seal(values[0]);
  const report = reportDelegationEvaluation(c, values); assert.equal(report.decision, 'keep-solo'); assert.match(report.pairs[0]!.reason || '', /elapsed-time tolerance/i);
});
test('faster but more expensive is a tradeoff and does not claim savings', () => {
  const c = readyCorpus(), values = paired(c); values[0].reportedUsage.tokens = 10000; seal(values[0]);
  const report = reportDelegationEvaluation(c, values); assert.equal(report.decision, 'keep-solo'); assert.equal(report.pairs[0]!.tradeoff, 'faster-but-more-expensive');
});
test('unknown usage blocks a token-efficiency conclusion and replay is deterministic', () => {
  const c = readyCorpus(), values = paired(c); values[0].reportedUsage = { coverage: 'unavailable' }; seal(values[0]);
  const first = reportDelegationEvaluation(c, values), replay = reportDelegationEvaluation(c, structuredClone(values));
  assert.equal(first.decision, 'insufficient'); assert.equal(first.pairs[0]!.tokenEfficiency, 'unavailable'); assert.deepEqual(replay, first);
});
test('passing exact evidence is eligible only for human rollout review', () => {
  const c = readyCorpus(); assert.equal(reportDelegationEvaluation(c, paired(c)).decision, 'eligible-for-human-rollout-review');
});
