import { digest, record, text } from './delegationContext';
import { parseModelSelection, type ModelSelection } from './modelSelection';
import type { Provider } from './model';

export const delegationEvaluationCorpusVersion = 1 as const;

export type EvaluationMode = 'solo' | 'auto';
export type RequiredEvaluationObservation = 'acceptance' | 'quality' | 'elapsed-time' | 'reported-usage' | 'regressions' | 'integration-conflicts' | 'manual-rework';

export interface EvaluationCommand { executable: string; args: string[] }
export interface EvaluationBudgetCeiling { maxSubmittedTurns: number; maxReportedTokens: number }
export interface EvaluationQualityThreshold { metric: string; minimumScore: number }
export interface EvaluationCase {
  id: string; repository: string; baseCommit: string; provider: Provider; modelSelection: ModelSelection;
  acceptanceCommands: EvaluationCommand[]; qualityThreshold: EvaluationQualityThreshold; budgetCeiling: EvaluationBudgetCeiling;
  requiredObservations: RequiredEvaluationObservation[]; caseSha256: string;
}
export interface EvaluationTolerances {
  samplesPerMode: number; qualityRegressionPoints: number; usageIncreasePercent: number; elapsedTimeIncreasePercent: number;
}
export interface DelegationEvaluationCorpus {
  version: 1; id: string; tolerances: EvaluationTolerances; cases: EvaluationCase[]; sha256: string;
}
/** A later run names its mode and binds to one immutable corpus baseline; it contains no run output. */
export interface EvaluationRunDescriptor {
  version: 1; mode: EvaluationMode; corpusId: string; corpusSha256: string; caseId: string; caseSha256: string;
}

const hash = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid evaluation corpus ${name}.`);
  return value;
};
const commit = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Evaluation cases require an immutable full base commit.');
  return value;
};
const identifier = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid evaluation corpus ${name}.`);
  return value;
};
const repository = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) throw new Error('Evaluation cases require a canonical repository identity.');
  return value;
};
const nonNegativeInteger = (value: unknown, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new Error(`Invalid evaluation corpus ${name}.`);
  return value as number;
};
const percentage = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Invalid evaluation corpus ${name}.`);
  return value;
};
const observationValues: RequiredEvaluationObservation[] = ['acceptance', 'quality', 'elapsed-time', 'reported-usage', 'regressions', 'integration-conflicts', 'manual-rework'];

function parseCommand(value: unknown): EvaluationCommand {
  const input = record(value, ['executable', 'args']);
  const executable = text(input.executable, 4096, 'acceptance executable');
  if (!Array.isArray(input.args) || input.args.length > 128 || input.args.some(arg => typeof arg !== 'string' || !arg || arg.length > 4000 || arg.includes('\0'))) throw new Error('Invalid evaluation corpus acceptance command.');
  return { executable, args: [...input.args] as string[] };
}
function parseTolerances(value: unknown): EvaluationTolerances {
  const input = record(value, ['samplesPerMode', 'qualityRegressionPoints', 'usageIncreasePercent', 'elapsedTimeIncreasePercent']);
  const samplesPerMode = nonNegativeInteger(input.samplesPerMode, 'samples per mode', 1000);
  if (samplesPerMode < 1) throw new Error('Evaluation corpus requires an explicit sample count.');
  return { samplesPerMode, qualityRegressionPoints: percentage(input.qualityRegressionPoints, 'quality tolerance'), usageIncreasePercent: percentage(input.usageIncreasePercent, 'usage tolerance'), elapsedTimeIncreasePercent: percentage(input.elapsedTimeIncreasePercent, 'elapsed-time tolerance') };
}
function parseCase(value: unknown): EvaluationCase {
  const input = record(value, ['id', 'repository', 'baseCommit', 'provider', 'modelSelection', 'acceptanceCommands', 'qualityThreshold', 'budgetCeiling', 'requiredObservations', 'caseSha256']);
  if (input.provider !== 'claude' && input.provider !== 'codex') throw new Error('Invalid evaluation corpus provider.');
  const modelSelectionInput = record(input.modelSelection, ['model', 'effort']);
  const modelSelection = parseModelSelection(modelSelectionInput);
  if (!Array.isArray(input.acceptanceCommands) || !input.acceptanceCommands.length || input.acceptanceCommands.length > 16) throw new Error('Evaluation cases require bounded acceptance commands.');
  const acceptanceCommands = input.acceptanceCommands.map(parseCommand);
  const qualityInput = record(input.qualityThreshold, ['metric', 'minimumScore']);
  const qualityThreshold = { metric: identifier(qualityInput.metric, 'quality metric'), minimumScore: percentage(qualityInput.minimumScore, 'quality threshold') };
  const budgetInput = record(input.budgetCeiling, ['maxSubmittedTurns', 'maxReportedTokens']);
  const budgetCeiling = { maxSubmittedTurns: nonNegativeInteger(budgetInput.maxSubmittedTurns, 'turn budget', 1000), maxReportedTokens: nonNegativeInteger(budgetInput.maxReportedTokens, 'reported-token budget', 100_000_000) };
  if (!budgetCeiling.maxSubmittedTurns || !budgetCeiling.maxReportedTokens) throw new Error('Evaluation cases require explicit non-zero budget ceilings.');
  if (!Array.isArray(input.requiredObservations) || !input.requiredObservations.length || input.requiredObservations.length > observationValues.length || input.requiredObservations.some(item => !observationValues.includes(item as RequiredEvaluationObservation))) throw new Error('Invalid evaluation corpus required observations.');
  const requiredObservations = [...input.requiredObservations] as RequiredEvaluationObservation[];
  if (new Set(requiredObservations).size !== requiredObservations.length || observationValues.some(item => !requiredObservations.includes(item))) throw new Error('Evaluation cases must require every evaluation observation.');
  const unsigned = { id: identifier(input.id, 'case id'), repository: repository(input.repository), baseCommit: commit(input.baseCommit), provider: input.provider as Provider, modelSelection, acceptanceCommands, qualityThreshold, budgetCeiling, requiredObservations };
  const caseSha256 = hash(input.caseSha256, 'case SHA-256');
  if (digest(JSON.stringify(unsigned)) !== caseSha256) throw new Error('Evaluation case changed. Create a new immutable case.');
  return { ...unsigned, caseSha256 };
}

/**
 * Parses a static corpus manifest only. It never reads a repository, executes
 * an acceptance command, creates a task, changes the Auto preference, or sends
 * a provider request.
 */
export function parseDelegationEvaluationCorpus(value: unknown): DelegationEvaluationCorpus {
  const input = record(value, ['version', 'id', 'tolerances', 'cases', 'sha256']);
  if (input.version !== delegationEvaluationCorpusVersion || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 128) throw new Error('Invalid evaluation corpus schema version or cases.');
  const tolerances = parseTolerances(input.tolerances), cases = input.cases.map(parseCase);
  if (new Set(cases.map(item => item.id)).size !== cases.length || new Set(cases.map(item => item.caseSha256)).size !== cases.length) throw new Error('Evaluation corpus contains duplicate cases.');
  const unsigned = { version: delegationEvaluationCorpusVersion, id: identifier(input.id, 'id'), tolerances, cases };
  const sha256 = hash(input.sha256, 'SHA-256');
  if (digest(JSON.stringify(unsigned)) !== sha256) throw new Error('Evaluation corpus changed. Create a new versioned corpus.');
  return { ...unsigned, sha256 };
}

export function parseEvaluationRunDescriptor(value: unknown): EvaluationRunDescriptor {
  const input = record(value, ['version', 'mode', 'corpusId', 'corpusSha256', 'caseId', 'caseSha256']);
  if (input.version !== delegationEvaluationCorpusVersion || (input.mode !== 'auto' && input.mode !== 'solo')) throw new Error('Invalid evaluation run descriptor.');
  return { version: delegationEvaluationCorpusVersion, mode: input.mode, corpusId: identifier(input.corpusId, 'run corpus id'), corpusSha256: hash(input.corpusSha256, 'run corpus SHA-256'), caseId: identifier(input.caseId, 'run case id'), caseSha256: hash(input.caseSha256, 'run case SHA-256') };
}

/** Auto and Solo are comparable only when they bind to the exact same immutable corpus case. */
export function assertEquivalentEvaluationPair(corpusValue: unknown, autoValue: unknown, soloValue: unknown): void {
  const corpus = parseDelegationEvaluationCorpus(corpusValue), auto = parseEvaluationRunDescriptor(autoValue), solo = parseEvaluationRunDescriptor(soloValue);
  if (auto.mode !== 'auto' || solo.mode !== 'solo') throw new Error('Evaluation pair requires one Auto and one Solo run.');
  if (auto.corpusId !== corpus.id || solo.corpusId !== corpus.id || auto.corpusSha256 !== corpus.sha256 || solo.corpusSha256 !== corpus.sha256 || auto.caseId !== solo.caseId || auto.caseSha256 !== solo.caseSha256) throw new Error('Auto and Solo evaluation runs must bind to the same corpus case baseline.');
  const baseline = corpus.cases.find(item => item.id === auto.caseId);
  if (!baseline || baseline.caseSha256 !== auto.caseSha256) throw new Error('Evaluation run does not bind to a corpus case baseline.');
}
