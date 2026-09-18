import type { Provider } from './model';
import { parseModelSelection, requireAdvertisedSelection, type ModelOption, type ModelSelection } from './modelSelection';
import { requireClaudeSelection } from './claudeControls';
import { buildChildContext, commit, containsScope, id, key, overlappingScopes, parseContextPolicy, record, scopePath, strings, text, type ContextManifest, type ContextPolicy } from './delegationContext';

export interface DelegationChild {
  key: string; goal: string; deliverable: string; baseCommit: string; writeScope: string[];
  dependencies: string[]; acceptance: string[]; testCommands: string[]; contextRefs: string[];
  provider: Provider; modelSelection?: ModelSelection;
}
export interface DelegationProposal {
  version: 1; id: string; parentId: string; runId: string; decision: 'solo' | 'delegate'; rationale: string; children: DelegationChild[];
}
export interface DelegationPolicy {
  parentId: string; runId: string; mode: 'solo' | 'auto'; level: 0 | 1; maxChildren: number;
  provider: Provider; modelSelection?: ModelSelection; models: ModelOption[];
  approvedBases: string[]; writeScope: string[]; otherOwners: string[]; context: ContextPolicy;
}
export interface PreparedDelegation {
  proposal: DelegationProposal; mode: 'solo' | 'auto'; order: string[];
  serialization: { before: string; after: string }[]; manifests: ContextManifest[];
}
export function parseDelegationProposal(value: unknown): DelegationProposal {
  const input = record(value, ['version', 'id', 'parentId', 'runId', 'decision', 'rationale', 'children']);
  if (input.version !== 1 || !['solo', 'delegate'].includes(input.decision as string) || !Array.isArray(input.children) || input.children.length > 8) throw new Error('Invalid delegation proposal.');
  const children: DelegationChild[] = input.children.map(value => {
    const child = record(value, ['key', 'goal', 'deliverable', 'baseCommit', 'writeScope', 'dependencies', 'acceptance', 'testCommands', 'contextRefs', 'provider', 'modelSelection']);
    if (child.provider !== 'claude' && child.provider !== 'codex') throw new Error('Invalid delegation provider.');
    const writeScope = strings(child.writeScope, 32, 512, 'write scope', scopePath), acceptance = strings(child.acceptance, 16, 2000, 'acceptance');
    if (new Set(writeScope.map(value => value.replace(/\/$/, '').toLowerCase())).size !== writeScope.length) throw new Error('Duplicate Windows ownership paths.');
    if (!writeScope.length || !acceptance.length) throw new Error('A writing child needs ownership and acceptance criteria.');
    let modelSelection: ModelSelection | undefined;
    if (child.modelSelection !== undefined) {
      record(child.modelSelection, ['model', 'effort']); modelSelection = parseModelSelection(child.modelSelection);
    }
    return { key: key(child.key), goal: text(child.goal, 8000, 'goal'), deliverable: text(child.deliverable, 2000, 'deliverable'), baseCommit: commit(child.baseCommit), writeScope,
      dependencies: strings(child.dependencies, 8, 64, 'dependencies', key), acceptance, testCommands: strings(child.testCommands, 16, 1000, 'suggested checks'),
      contextRefs: strings(child.contextRefs, 8, 64, 'context references', key), provider: child.provider as Provider, ...(modelSelection ? { modelSelection } : {}) };
  });
  const decision = input.decision as DelegationProposal['decision'];
  if (new Set(children.map(child => child.key)).size !== children.length || decision === 'solo' && children.length || decision === 'delegate' && !children.length) throw new Error('Invalid or duplicate delegation children.');
  return { version: 1, id: id(input.id), parentId: id(input.parentId), runId: id(input.runId), decision, rationale: text(input.rationale, 1000, 'rationale'), children };
}
function ordered(children: DelegationChild[]): string[] {
  const result: string[] = [];
  while (result.length < children.length) {
    const next = children.find(child => !result.includes(child.key) && child.dependencies.every(dependency => result.includes(dependency)));
    if (!next) throw new Error('Delegation dependencies contain a cycle or missing child.');
    result.push(next.key);
  }
  return result;
}
function precedes(children: DelegationChild[], before: string, after: string): boolean {
  const child = children.find(child => child.key === after)!;
  return child.dependencies.some(dependency => dependency === before || precedes(children, before, dependency));
}
/** Preparation does not create tasks, reserve execution slots, or submit any provider turn. */
export function prepareDelegation(value: unknown, policy: DelegationPolicy, usedKeys: string[] = []): PreparedDelegation {
  const proposal = parseDelegationProposal(value);
  policy = parseDelegationPolicy(policy);
  if (proposal.parentId !== id(policy.parentId) || proposal.runId !== id(policy.runId) || !['solo', 'auto'].includes(policy.mode) || ![0, 1].includes(policy.level) || !['claude', 'codex'].includes(policy.provider) || !Number.isSafeInteger(policy.maxChildren) || policy.maxChildren < 1 || policy.maxChildren > 8) throw new Error('Invalid host delegation policy or parent identity.');
  if (usedKeys.length > 8 || new Set(usedKeys).size !== usedKeys.length || usedKeys.some(value => key(value) !== value)) throw new Error('Invalid delegation run ledger.');
  if (proposal.decision === 'delegate' && (policy.mode === 'solo' || policy.level !== 0)) throw new Error('Solo and child tasks cannot delegate through Hydra.');
  if (proposal.children.length && proposal.children.length > policy.maxChildren - usedKeys.length || proposal.children.some(child => usedKeys.includes(child.key))) throw new Error('The entire parent run child limit is exhausted or a child key was reused. Replanning cannot reset it.');
  const approved = strings(policy.approvedBases, 64, 40, 'approved bases', commit), allowed = strings(policy.writeScope, 64, 512, 'host write scope', scopePath), otherOwners = strings(policy.otherOwners, 256, 512, 'other owners', scopePath);
  const children = proposal.children;
  for (const child of children) {
    if (!approved.includes(child.baseCommit)) throw new Error('The selected child base was not verified by the host.');
    if (child.writeScope.some(requested => !allowed.some(owner => containsScope(owner, requested))) || overlappingScopes(child.writeScope, otherOwners)) throw new Error('Child ownership expands scope or conflicts with another owner.');
    if (child.dependencies.some(dependency => dependency === child.key || !children.some(candidate => candidate.key === dependency))) throw new Error('Invalid child dependency.');
    if (child.provider !== policy.provider || child.modelSelection?.model !== policy.modelSelection?.model || child.modelSelection?.effort !== policy.modelSelection?.effort) throw new Error('Children must inherit the parent provider and model/effort.');
    if (child.modelSelection) {
      if (policy.provider === 'claude') requireClaudeSelection(policy.models, child.modelSelection);
      else requireAdvertisedSelection(policy.models, child.modelSelection);
    }
  }
  ordered(children); // Reject cycles before recursively comparing existing dependency paths.
  const serialization: PreparedDelegation['serialization'] = [];
  for (let index = 0; index < children.length; index++) {
    const before = children[index]!;
    for (const after of children.slice(index + 1)) {
      if (!overlappingScopes(before.writeScope, after.writeScope) || precedes(children, before.key, after.key) || precedes(children, after.key, before.key)) continue;
      after.dependencies.push(before.key); serialization.push({ before: before.key, after: after.key });
    }
  }
  const order = ordered(children);
  const manifests = children.map(child => buildChildContext({ ...child, parentId: proposal.parentId, runId: proposal.runId }, policy.context));
  return { proposal, mode: policy.mode, order, serialization, manifests };
}

export const defaultDelegationPreferences = () => ({ mode: 'solo' as const, maxChildren: 2 });
/** Host input stays separate from model proposals; permissive extra fields are never persisted. */
export function parseDelegationPolicy(value: unknown): DelegationPolicy {
  const input = record(value, ['parentId', 'runId', 'mode', 'level', 'maxChildren', 'provider', 'modelSelection', 'models', 'approvedBases', 'writeScope', 'otherOwners', 'context']);
  const mode = input.mode ?? 'solo', maxChildren = input.maxChildren ?? 2;
  if (!['solo', 'auto'].includes(mode as string) || ![0, 1].includes(input.level as number) || !['claude', 'codex'].includes(input.provider as string) || !Number.isSafeInteger(maxChildren) || (maxChildren as number) < 1 || (maxChildren as number) > 8 || !Array.isArray(input.models) || input.models.length > 100) throw new Error('Invalid host delegation policy.');
  const models: ModelOption[] = input.models.map(value => {
    const option = record(value, ['model', 'displayName', 'efforts', 'defaultEffort', 'canonicalModel']);
    const model = parseModelSelection({ model: option.model, effort: 'low' }).model;
    const efforts = strings(option.efforts, 32, 40, 'efforts', value => parseModelSelection({ model, effort: value }).effort);
    if (typeof option.defaultEffort !== 'string' || option.defaultEffort && !efforts.includes(option.defaultEffort)) throw new Error('Invalid advertised default effort.');
    return { model, displayName: text(option.displayName, 200, 'model display name'), efforts, defaultEffort: option.defaultEffort,
      ...(option.canonicalModel === undefined ? {} : { canonicalModel: parseModelSelection({ model: option.canonicalModel, effort: 'low' }).model }) };
  });
  if (new Set(models.map(model => model.model)).size !== models.length) throw new Error('Duplicate advertised models.');
  let modelSelection: ModelSelection | undefined;
  if (input.modelSelection !== undefined) { record(input.modelSelection, ['model', 'effort']); modelSelection = parseModelSelection(input.modelSelection); }
  return { parentId: id(input.parentId), runId: id(input.runId), mode: mode as 'solo' | 'auto', level: input.level as 0 | 1, maxChildren: maxChildren as number,
    provider: input.provider as Provider, ...(modelSelection ? { modelSelection } : {}), models,
    approvedBases: strings(input.approvedBases, 64, 40, 'approved bases', commit), writeScope: strings(input.writeScope, 64, 512, 'host write scope', scopePath),
    otherOwners: strings(input.otherOwners, 256, 512, 'other owners', scopePath), context: parseContextPolicy(input.context) };
}
