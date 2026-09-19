import { createHash, randomBytes } from 'node:crypto';
import type { Task, Turn } from './model';
import { id, record, text } from './delegationContext';
import { hostDelegationPolicy } from './delegationHost';
import { parseDelegationPolicy, type DelegationPolicy, type DelegationProposal } from './delegationPlan';
import type { DelegationPreferences } from './delegationPreferences';

export interface DelegationPlannerRun {
  version: 1;
  runId: string;
  state: 'prepared' | 'submitted' | 'accepted' | 'rejected';
  policy: DelegationPolicy;
  preferences: DelegationPreferences;
  turnId?: string;
  proposalId?: string;
  sha256?: string;
  error?: string;
}

export interface PlannerDecisionStore { recordDecision(value: unknown, policy: DelegationPolicy): Promise<unknown> }
export const plannerMarker = 'HYDRA_DELEGATION_V1:';
const turnId = (value: unknown) => id(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host-created receipt. This contains policy facts, never model reasoning or output. */
export function createDelegationPlannerRun(policyValue: unknown, preferences: DelegationPreferences, runId = randomBytes(6).toString('hex')): DelegationPlannerRun {
  const policy = parseDelegationPolicy(policyValue);
  if (policy.runId !== id(runId) || preferences.status !== 'preparation') throw new Error('Invalid planner ownership receipt.');
  return { version: 1, runId: policy.runId, state: 'prepared', policy, preferences: structuredClone(preferences) };
}

export function parseDelegationPlannerRun(value: unknown): DelegationPlannerRun {
  const input = record(value, ['version', 'runId', 'state', 'policy', 'preferences', 'turnId', 'proposalId', 'sha256', 'error']);
  if (input.version !== 1 || !['prepared', 'submitted', 'accepted', 'rejected'].includes(input.state as string)) throw new Error('Invalid delegation planner receipt.');
  const policy = parseDelegationPolicy(input.policy);
  if (policy.runId !== id(input.runId)) throw new Error('Planner receipt run identity mismatch.');
  const preferences = input.preferences;
  if (!preferences || typeof preferences !== 'object' || !['solo', 'auto'].includes((preferences as any).mode) || !Number.isSafeInteger((preferences as any).maxChildren) || (preferences as any).maxChildren < 1 || (preferences as any).maxChildren > 8 || (preferences as any).status !== 'preparation') throw new Error('Invalid planner preference snapshot.');
  const state = input.state as DelegationPlannerRun['state'];
  const hasTurn = input.turnId !== undefined;
  if ((state === 'prepared' && hasTurn) || (state !== 'prepared' && !hasTurn) || (hasTurn && !/^[a-f0-9]{12}$/.test(input.turnId as string))) throw new Error('Invalid planner turn lifecycle.');
  if (state === 'accepted' && (!/^[a-f0-9]{12}$/.test(input.proposalId as string) || !/^[a-f0-9]{64}$/.test(input.sha256 as string))) throw new Error('Invalid accepted planner receipt.');
  if (state === 'rejected' && (typeof input.error !== 'string' || !(input.error as string).trim() || (input.error as string).length > 500)) throw new Error('Invalid rejected planner receipt.');
  return { version: 1, runId: policy.runId, state, policy, preferences: { mode: (preferences as any).mode, maxChildren: (preferences as any).maxChildren, status: 'preparation' }, ...(hasTurn ? { turnId: input.turnId as string } : {}), ...(state === 'accepted' ? { proposalId: input.proposalId as string, sha256: input.sha256 as string } : {}), ...(state === 'rejected' ? { error: input.error as string } : {}) };
}

/** The provider receives this visible normal-turn suffix; only this exact one-line marker is eligible. */
export function plannerPromptSuffix(run: DelegationPlannerRun): string {
  const solo = { version: 1, id: run.runId, parentId: run.policy.parentId, runId: run.runId, decision: 'solo', rationale: 'Brief reason for keeping this work with one agent.', children: [] };
  const child = { key: 'independent-part', goal: 'Specific bounded goal', deliverable: 'Concrete result', baseCommit: run.policy.approvedBases[0], writeScope: ['src/example/'], dependencies: [], acceptance: ['Observable acceptance check'], testCommands: [], contextRefs: [], provider: run.policy.provider, ...(run.policy.modelSelection ? { modelSelection: run.policy.modelSelection } : {}) };
  return `\n\nHydra planning receipt: ${run.runId}. Complete the normal parent task first. At the end of your response emit exactly one line beginning ${plannerMarker} followed by compact JSON. Solo shape: ${JSON.stringify(solo)}. ${run.preferences.mode === 'auto' ? `If genuinely independent work remains, use decision "delegate" with the same version, id, parentId and runId, a brief rationale, and children shaped like ${JSON.stringify(child)}. Every child must use the recorded base and provider, stay within host write scope ${JSON.stringify(run.policy.writeScope)}, and have distinct nonoverlapping write scopes. The host validates and may refuse the proposal.` : 'The saved Solo preference requires the Solo shape.'} The rationale is a concise user-visible explanation, not hidden reasoning.`;
}
export function bindDelegationPlannerTurn(run: DelegationPlannerRun, turn: Pick<Turn, 'id'>): DelegationPlannerRun {
  const value = parseDelegationPlannerRun(run);
  if (value.state !== 'prepared') throw new Error('Planner receipt is already bound to a turn.');
  return { ...value, state: 'submitted', turnId: turnId(turn.id) };
}
export function extractDelegationPlannerProposal(output: string): unknown {
  if (typeof output !== 'string' || output.length > 1024 * 1024) throw new Error('Invalid planner completion output.');
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(plannerMarker));
  if (lines.length !== 1) throw new Error('A normal turn must contain exactly one explicit Hydra delegation marker.');
  const source = lines[0]!.slice(plannerMarker.length).trim();
  if (!source || source.length > 64000) throw new Error('Invalid marked delegation proposal.');
  try { return JSON.parse(source); } catch { throw new Error('Marked delegation proposal is not valid JSON.'); }
}
export async function ingestDelegationPlannerCompletion(input: { task: Task; turn: Pick<Turn, 'id' | 'status' | 'text'>; decisions: PlannerDecisionStore }): Promise<DelegationPlannerRun | undefined> {
  const current = input.task.delegationPlanner;
  if (!current) return undefined;
  const run = parseDelegationPlannerRun(current);
  if (run.state === 'accepted' || run.state === 'rejected') return run;
  if (run.state !== 'submitted' || run.turnId !== turnId(input.turn.id) || input.turn.status !== 'completed') throw new Error('Planner completion does not match the submitted normal turn.');
  let proposal: DelegationProposal;
  let bound: ReturnType<typeof hostDelegationPolicy>;
  try {
    proposal = extractDelegationPlannerProposal(input.turn.text) as DelegationProposal;
    bound = hostDelegationPolicy(proposal, run.policy, input.task, run.preferences);
  } catch (error) {
    const rejected: DelegationPlannerRun = { ...run, state: 'rejected', error: text(error instanceof Error ? error.message : String(error), 500, 'planner rejection') };
    input.task.delegationPlanner = rejected;
    return rejected;
  }
  // A decision-store failure is recoverable: retain the submitted receipt so
  // restart can replay the immutable completed turn without another model turn.
  await input.decisions.recordDecision(bound!.proposal, bound!.policy);
  const accepted: DelegationPlannerRun = { ...run, state: 'accepted', proposalId: id(bound.proposal.id), sha256: hash(bound.proposal) };
  input.task.delegationPlanner = accepted;
  return accepted;
}
