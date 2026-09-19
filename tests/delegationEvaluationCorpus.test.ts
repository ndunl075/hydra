import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertEquivalentEvaluationPair, parseDelegationEvaluationCorpus } from '../src/core/delegationEvaluationCorpus';
import { digest } from '../src/core/delegationContext';

const fixture = (): any => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/corpus-v1.json', 'utf8'));
const pairFixture = (): any => JSON.parse(readFileSync('tests/fixtures/delegation-evaluation/paired-runs-v1.json', 'utf8'));
const sealCase = (item: any) => {
  const { caseSha256: _ignored, ...unsigned } = item;
  item.caseSha256 = digest(JSON.stringify(unsigned));
};
const seal = (corpus: any) => {
  corpus.cases.forEach(sealCase);
  const { sha256: _ignored, ...unsigned } = corpus;
  corpus.sha256 = digest(JSON.stringify(unsigned));
  return corpus;
};

test('a versioned fixture is validated locally without executing its declared commands', () => {
  const corpus = fixture();
  const parsed = parseDelegationEvaluationCorpus(corpus);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), corpus);
  assert.equal(parsed.tolerances.samplesPerMode, 3);
});

test('the exact schema and version are required', () => {
  const wrongVersion = seal(fixture()); wrongVersion.version = 2; seal(wrongVersion);
  assert.throws(() => parseDelegationEvaluationCorpus(wrongVersion), /schema version/);
  const extra = seal(fixture()); extra.cases[0].prompt = 'never retained'; seal(extra);
  assert.throws(() => parseDelegationEvaluationCorpus(extra), /Invalid delegation fields/);
});

test('mutable, duplicate, and unpinned cases are refused', () => {
  const changed = seal(fixture()); changed.cases[0].baseCommit = 'b'.repeat(40);
  assert.throws(() => parseDelegationEvaluationCorpus(changed), /changed/);
  const duplicate = seal(fixture()); duplicate.cases.push(structuredClone(duplicate.cases[0])); seal(duplicate);
  assert.throws(() => parseDelegationEvaluationCorpus(duplicate), /duplicate/);
  const branch = seal(fixture()); branch.cases[0].baseCommit = 'main'; sealCase(branch.cases[0]); seal(branch);
  assert.throws(() => parseDelegationEvaluationCorpus(branch), /immutable full base commit/);
});

test('paired Auto and Solo descriptors must bind to one exact immutable corpus case baseline', () => {
  const corpus = seal(fixture()), { auto, solo } = pairFixture();
  assert.doesNotThrow(() => assertEquivalentEvaluationPair(corpus, auto, solo));
  assert.throws(() => assertEquivalentEvaluationPair(corpus, auto, { ...solo, mode: 'auto' }), /one Auto and one Solo/);
  assert.throws(() => assertEquivalentEvaluationPair(corpus, auto, { ...solo, caseId: 'other-case' }), /same corpus case baseline/);
  assert.throws(() => assertEquivalentEvaluationPair(corpus, auto, { ...solo, caseSha256: 'b'.repeat(64) }), /same corpus case baseline/);
});

test('credentials, prompt transcripts, missing usage observations, and implicit samples or tolerances cannot enter the corpus', () => {
  const credential = seal(fixture()); credential.cases[0].credential = 'secret'; seal(credential);
  assert.throws(() => parseDelegationEvaluationCorpus(credential), /Invalid delegation fields/);
  const transcript = seal(fixture()); transcript.cases[0].transcript = 'provider conversation'; seal(transcript);
  assert.throws(() => parseDelegationEvaluationCorpus(transcript), /Invalid delegation fields/);
  const missingUsage = seal(fixture()); missingUsage.cases[0].requiredObservations = missingUsage.cases[0].requiredObservations.filter((item: string) => item !== 'reported-usage'); sealCase(missingUsage.cases[0]); seal(missingUsage);
  assert.throws(() => parseDelegationEvaluationCorpus(missingUsage), /every evaluation observation/);
  const missingRegression = seal(fixture()); missingRegression.cases[0].requiredObservations = missingRegression.cases[0].requiredObservations.filter((item: string) => item !== 'regressions'); sealCase(missingRegression.cases[0]); seal(missingRegression);
  assert.throws(() => parseDelegationEvaluationCorpus(missingRegression), /every evaluation observation/);
  const missingTolerance = seal(fixture()); delete missingTolerance.tolerances.usageIncreasePercent; seal(missingTolerance);
  assert.throws(() => parseDelegationEvaluationCorpus(missingTolerance), /usage tolerance/);
});
