import { buildTaskPrompt, parseBrief, parseHandoffSummary } from './taskContext';
import { parseResources, type ResourceConfig, type ResourceView } from './resourceModel';
import type { UsageSummary } from './usage';
import { parseBudgets, type SoftBudget, type BudgetSettings, type BudgetObservation } from './budgets';
import type { DiscardReceipt, DiscardReview } from './discard';
import { parseModelSelection, type ModelSelection, type ModelCatalog, type TurnModelSettings } from './modelSelection';
import type { CapacityView } from './profileCapacity';
import type { TaskSchedule } from './scheduler';
import { parseIntegrationCommands, type IntegrationCommand, type IntegrationOperation } from './integrationModel';
import type { ConversationDraft } from './conversationDrafts';
import { requireDelegationMode, type DelegationPreferences, type DelegationMode } from './delegationPreferences';
import type { DelegatedVerificationEvidence } from './delegationEvidence';
import type { DelegationResultBoundary } from './delegationResultBoundary';
import type { DelegationPlannerRun } from './delegationPlannerIngestion';
import type { DelegationOrchestrationProjection } from './delegationOrchestrationJournal';
import type { DelegatedExecutionReceipt } from './delegationRunner';
import type { DelegationApprovalPauseRecord } from './delegationApprovalPause';
import type { ParentReviewDecision } from './delegationParentReview';
import type { SelectedTaskSetupPreview } from './setupPreviewProjection';
import type { DelegationBudgetReservation, DelegationRunUsageProjection } from './delegationRunAccounting';
import type { DelegationReconciliationProjection } from './delegationReconciliation';
export type Provider = 'claude' | 'codex';
export interface TaskBrief { goal: string; constraints: string; relevantPaths: string; acceptance: string; testCommands: string }
export interface TaskHandoffSummary { summary: string; decisions: string; validation: string; unresolved: string; evidenceRefs: string }
export type TaskState = 'idle' | 'external' | 'running' | 'interrupted' | 'error' | 'discarded';
export interface Task {
  id: string; title: string; prompt: string; repository: string; worktree: string;
  branch: string; baseCommit: string; integrationTarget: string; provider: Provider;
  interface: 'interactive-cli' | 'official-extension' | 'managed-cli'; state: TaskState; createdAt: string; updatedAt: string;
  sessionId?: string; sessionProvider?: Provider; providerVersion?: string;
  error?: string;
  reviewedCommit?: ReviewedCommit;
  discard?: DiscardReceipt;
  brief?: TaskBrief;
  contextLockedAt?: string;
  handoffSummary?: TaskHandoffSummary;
  modelSelection?: ModelSelection;
  schedule?: TaskSchedule;
  delegationExecution?: DelegatedExecutionReceipt;
  /** Opaque, durable approval-pause sources for provenance-backed graph replay. */
  delegationApprovalPauses?: DelegationApprovalPauseRecord[];
  /** One automatic retry is charged to the original delegated child/run and never resets. */
  delegationRetry?: { version: 1; parentId: string; runId: string; dispatchKey: string; attemptedAt: string };
  /** A sibling-local launch/turn budget-check fence; it carries no spend estimate. */
  delegationBudgetReservation?: DelegationBudgetReservation;
    delegation?: { parentId: string; runId: string; childKey: string; dispatchKey: string; dependencies: string[] };
    /** Durable retry marker for an assignment fact whose source transition committed first. */
    delegationJournalPending?: { version: 1; event: { version: 1; id: string; occurredAt: string; kind: 'assignment'; parentId: string; runId: string; from: { kind: 'task'; taskId: string }; to: { kind: 'task'; taskId: string }; provenance: { producer: 'host'; recordId: string } } };
  /** Host-bound normal-turn planner lifecycle. It never represents child execution. */
  delegationPlanner?: DelegationPlannerRun;
  /** Durable verification attempts for a managed delegated child. */
  verificationEvidence?: DelegatedVerificationEvidence;
  /** Immutable inspection receipts for verification superseded by a later reviewed result. */
  delegationResultBoundaries?: DelegationResultBoundary[];
}
export interface ReviewedCommit { commit: string; tree: string; baseCommit: string; reviewedAt: string }
export interface PreparedReview { token: string; head: string; tree: string; baseCommit: string; branch: string; indexHash: string; createdAt: string; files: FileChange[] }
export type DiffLayer = 'combined' | 'committed' | 'staged' | 'unstaged' | 'untracked';
export const diffLabels: Record<DiffLayer, string> = { combined: 'Base → saved files', committed: 'Committed', staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' };
export interface FileChange { path: string; beforePath?: string; status: string; layer: DiffLayer }
export interface TaskFile { path: string; status: string; changes?: FileChange[] }
export interface ProviderInfo { provider: Provider; executable?: string; available: boolean }
export interface ProviderDiagnostic {
  provider: Provider; executable?: string; status: 'checking' | 'checked' | 'unavailable' | 'error';
  version?: string; checkedAt: string; advertised: string[]; error?: string;
  probes: { args: string[]; stdout: string; stderr: string; exitCode: number | null; error?: string }[];
}
export interface Draft { title: string; prompt: string; provider: Provider; brief?: TaskBrief }
export interface Turn {
  provider?: Provider;
  id: string; prompt: string; text: string; status: 'running' | 'completed' | 'error' | 'interrupted';
  createdAt: string; error?: string; permissionDenials?: number;
  textTruncated?: boolean;
  usage?: { input: number; output: number; cacheRead?: number; cacheCreated?: number; estimatedUsd?: number };
  usageSource?: 'claude-result' | 'codex-last-request';
  /** Cumulative root-thread snapshot; never sum these across turns. */
  threadUsage?: { sessionId: string; input: number; output: number; cacheRead?: number; cacheCreated?: number };
  modelSettings?: TurnModelSettings;
}
export interface Approval { id: string; kind: 'command' | 'file' | 'network'; detail: string }
export interface SessionView { version: 1; turns: Turn[]; writerUncertain?: boolean; active?: boolean; totalTurns?: number; approvals?: Approval[] }
export type HandoffTask = Pick<Task, 'id' | 'title' | 'prompt' | 'repository' | 'worktree' | 'branch' | 'baseCommit' | 'provider'>;
export interface Handoff { version: 1; task: HandoffTask }
export interface OfficialExtensionInfo { provider: Provider; extensionId: string; installed: boolean; version?: string; commandAvailable: boolean; commandTitle: string }
export interface DelegationPlanView { runId: string; id: string; rationale: string; mode: 'solo' | 'auto'; decision: 'solo' | 'delegate'; children: { key: string; goal: string; provider: Provider; writeScope: string[]; dependencies: string[]; brief: string }[] }
export interface Snapshot {
  capacity?: CapacityView;
  /** Current selected child only; stale historical decisions are never presented as current. */
  parentReview?: { decision: ParentReviewDecision; reviewedAt: string; reason: string };
  resources?: Record<string, ResourceView>;
  setupPreview?: SelectedTaskSetupPreview;
  tasks: Task[]; selectedId?: string; mode: 'editor' | 'agents'; repositories: string[];
  providers: ProviderInfo[]; files: TaskFile[]; busy: boolean; error?: string; draft?: Draft;
  handoff?: Handoff; officialExtensions?: OfficialExtensionInfo[];
  diagnostics?: ProviderDiagnostic[];
  session?: SessionView;
  conversationDraft?: ConversationDraft;
  /** Local activity only; no other task's transcript or approval details. */
  taskActivity?: Record<string, { active: boolean; awaitingApproval: boolean }>;
  commitReview?: PreparedReview;
  usage?: { tasks: Record<string, UsageSummary>; projects: Record<string, UsageSummary>; delegationRuns?: Record<string, UsageSummary> };
  delegationRunAccounting?: Record<string, DelegationRunUsageProjection>;
  delegationReconciliation?: Record<string, DelegationReconciliationProjection>;
  modelCatalogs?: Record<string, ModelCatalog>;
  /** Task-independent model discovery for the task-creation picker, keyed by provider. */
  draftModelCatalogs?: Partial<Record<Provider, ModelCatalog>>;
  integration?: IntegrationOperation;
  discardReview?: DiscardReview;
  budgets?: { settings: BudgetSettings; observations: Record<string, BudgetObservation[]> };
  delegation?: DelegationPreferences;
    delegationPlans?: Record<string, DelegationPlanView[]>;
    /** Read-only durable delegation facts. No event is inferred from task state. */
    delegationOrchestration?: Record<string, DelegationOrchestrationProjection>;
}
export type ClientMessage =
  | { type: 'supplyDelegationContext'; id: string; requestKey: string }
  | { type: 'reviewDelegationResult'; id: string; decision: 'approved' | 'rejected'; reason: string }
  | { type: 'saveResources'; id: string; config: ResourceConfig }
  | { type: 'runSetup' | 'stopSetup' | 'reconcileSetup' | 'releaseResources' | 'reacquireResources' | 'showSetupLog'; id: string }
  | { type: 'ready' | 'editor' | 'agents' | 'newTask' | 'refresh' | 'settings' | 'openQuota' | 'attachContext' }
  | { type: 'select' | 'launch' | 'terminal' | 'copyPrompt' | 'openWorktree' | 'stop' | 'releaseExternal' | 'startManaged' | 'showSessionDiagnostics' | 'cancelQueued' | 'reconcileWriter' | 'reconcileCapacity'; id: string }
  | { type: 'configureSchedule'; id: string; dependencies: string[]; startFromDependency?: string }
  | { type: 'saveBudgets'; id: string; scope: 'task' | 'project'; budgets: SoftBudget[] }
  | { type: 'retryBudgetHold'; id: string }
  | { type: 'followUp'; id: string; prompt: string; draftVersion?: string }
  | { type: 'conversationDraft'; id: string; prompt: string; version: string }
  | { type: 'saveBrief'; id: string; brief: TaskBrief }
  | { type: 'saveHandoffSummary'; id: string; handoffSummary: TaskHandoffSummary }
  | { type: 'showTaskHandoff'; id: string }
  | { type: 'checkModels'; id: string }
  | { type: 'saveModelSelection'; id: string; selection: ModelSelection | null }
  | { type: 'approve'; id: string; approvalId: string; decision: 'accept' | 'decline' }
  | { type: 'handoff'; id: string; provider: Provider }
  | { type: 'checkProvider' | 'showProviderDiagnostics'; provider: Provider }
  | { type: 'checkModelsForProvider'; provider: Provider }
  | { type: 'openOfficial' | 'showOfficial' | 'copyHandoffPrompt' }
  | { type: 'openFile'; id: string; path: string }
  | { type: 'openDiff'; id: string; path: string; layer: DiffLayer }
  | { type: 'prepareCommitReview'; id: string }
  | { type: 'prepareDiscard' | 'restoreDiscarded' | 'copyDiscardLocation'; id: string }
  | { type: 'confirmDiscard'; id: string; token: string }
  | { type: 'openCommitReview'; id: string; token: string; path: string }
  | { type: 'commitReviewed'; id: string; token: string; message: string }
  | { type: 'prepareIntegration'; id: string; checks: IntegrationCommand[] }
  | { type: 'promoteIntegration' | 'reviewIntegrationResolution' | 'copyIntegrationCandidate' | 'showIntegrationLog' | 'cancelIntegration'; id: string; operationId: string }
  | { type: 'acceptIntegrationResolution'; id: string; operationId: string; token: string }
  | { type: 'openIntegrationDiff'; id: string; operationId: string; path: string }
  | { type: 'create'; title: string; prompt: string; provider: Provider; repository: string; startingCommit?: string; brief?: TaskBrief; autoStart?: boolean }
  | { type: 'draft'; title: string; prompt: string; provider: Provider; brief?: TaskBrief }
  | { type: 'setDelegationMode'; mode: DelegationMode };

export function parseMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== 'object') throw new Error('Invalid message.');
  const message = value as Record<string, unknown>;
  const string = (key: string, max = 500): string => {
    const result = message[key];
    if (typeof result !== 'string' || result.length > max || result.includes('\0')) throw new Error(`Invalid ${key}.`);
    return result;
  };
  const type = string('type');
  if (type === 'supplyDelegationContext' || type === 'reviewDelegationResult') {
    const id = string('id'); if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'supplyDelegationContext') { const requestKey = string('requestKey'); if (!/^[a-f0-9]{24}$/.test(requestKey)) throw new Error('Invalid context request.'); return { type, id, requestKey }; }
    const decision = string('decision'); if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid parent review decision.');
    const reason = string('reason', 1200); if (!reason.trim()) throw new Error('Enter a concise parent review reason.');
    return { type, id, decision, reason };
  }
  if (type === 'setDelegationMode') {
    return { type, mode: requireDelegationMode(string('mode')) };
  }
  if (['saveResources', 'runSetup', 'stopSetup', 'reconcileSetup', 'releaseResources', 'reacquireResources', 'showSetupLog'].includes(type)) {
    const id = string('id'); if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    return type === 'saveResources' ? { type, id, config: parseResources(message.config) } : { type, id } as ClientMessage;
  }
  if (type === 'saveBudgets' || type === 'retryBudgetHold') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'retryBudgetHold') return { type, id };
    const scope = string('scope');
    if (scope !== 'task' && scope !== 'project') throw new Error('Invalid budget scope.');
    return { type, id, scope, budgets: parseBudgets(message.budgets) };
  }
  if (['prepareDiscard', 'confirmDiscard', 'restoreDiscarded', 'copyDiscardLocation'].includes(type)) {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'confirmDiscard') {
      const token = string('token');
      if (!/^[a-f0-9]{24}$/.test(token)) throw new Error('Invalid discard review token.');
      return { type, id, token };
    }
    return { type, id } as ClientMessage;
  }
  if (type === 'checkModels' || type === 'saveModelSelection') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    return type === 'checkModels' ? { type, id } : { type, id, selection: message.selection === null ? null : parseModelSelection(message.selection) };
  }
  if (['create', 'draft', 'startManaged', 'followUp', 'saveBrief'].includes(type) && ['model', 'effort', 'reasoningEffort', 'reasoning_effort'].some(key => key in message)) {
    throw new Error('Direct launch-time model and effort fields are unsupported. Save a verified managed selection before launching; Hydra cannot confirm an Astra High preset unless the exact model and effort are advertised.');
  }
  if (type === 'saveBrief' || type === 'saveHandoffSummary' || type === 'showTaskHandoff') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'showTaskHandoff') return { type, id };
    if (type === 'saveHandoffSummary') return { type, id, handoffSummary: parseHandoffSummary(message.handoffSummary) };
    const brief = parseBrief(message.brief);
    if (!brief.goal.trim()) throw new Error('Enter a task goal.');
    return { type, id, brief };
  }
  if (type === 'prepareIntegration' || ['promoteIntegration','reviewIntegrationResolution','acceptIntegrationResolution','copyIntegrationCandidate','showIntegrationLog','cancelIntegration','openIntegrationDiff'].includes(type)) {
    const id = string('id'); if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'prepareIntegration') return { type, id, checks: parseIntegrationCommands(message.checks) };
    const operationId = string('operationId'); if (!/^[a-f0-9]{24}$/.test(operationId)) throw new Error('Invalid integration operation.');
    if (type === 'openIntegrationDiff') return { type, id, operationId, path: string('path',4096) };
    if (type === 'acceptIntegrationResolution') { const token=string('token');if(!/^[a-f0-9]{24}$/.test(token))throw new Error('Invalid resolution review.');return {type,id,operationId,token}; }
    return { type, id, operationId } as ClientMessage;
  }
  if (type === 'prepareCommitReview' || type === 'openCommitReview' || type === 'commitReviewed') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'prepareCommitReview') return { type, id };
    const token = string('token');
    if (!/^[a-f0-9]{24}$/.test(token)) throw new Error('Invalid review token.');
    if (type === 'openCommitReview') return { type, id, token, path: string('path', 4096) };
    const message = string('message', 500);
    if (!message.trim()) throw new Error('Enter a commit message.');
    return { type, id, token, message };
  }
  if (type === 'configureSchedule') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id) || !Array.isArray(message.dependencies) || message.dependencies.length > 100 || !message.dependencies.every(value => typeof value === 'string' && /^[a-f0-9]{12}$/.test(value))) throw new Error('Invalid dependencies.');
    return { type, id, dependencies: message.dependencies as string[], startFromDependency: message.startFromDependency === undefined ? undefined : string('startFromDependency') || undefined };
  }
  if (type === 'approve') {
    const id = string('id'), approvalId = string('approvalId'), decision = string('decision');
    if (!/^[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{12}$/.test(approvalId) || !['accept', 'decline'].includes(decision)) throw new Error('Invalid approval decision.');
    return { type, id, approvalId, decision } as ClientMessage;
  }
  if (type === 'checkProvider' || type === 'showProviderDiagnostics' || type === 'checkModelsForProvider') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    return { type, provider };
  }
  if (['ready', 'editor', 'agents', 'newTask', 'refresh', 'settings', 'openQuota', 'openOfficial', 'showOfficial', 'copyHandoffPrompt', 'attachContext'].includes(type)) return { type } as ClientMessage;
  if (type === 'handoff') {
    const id = string('id');
    const provider = string('provider');
    if (!/^[a-f0-9]{12}$/.test(id) || (provider !== 'claude' && provider !== 'codex')) throw new Error('Invalid handoff.');
    return { type, id, provider };
  }
  if (type === 'conversationDraft') {
    const id = string('id'), prompt = string('prompt', 32000), version = string('version', 100);
    if (!/^[a-f0-9]{12}$/.test(id) || !/^[a-zA-Z0-9-]{1,100}$/.test(version)) throw new Error('Invalid conversation draft.');
    return { type, id, prompt, version };
  }
  if (type === 'followUp') {
    const id = string('id'), prompt = string('prompt', 32000);
    if (!/^[a-f0-9]{12}$/.test(id) || !prompt.trim()) throw new Error('Invalid follow-up.');
    const draftVersion = message.draftVersion === undefined ? undefined : string('draftVersion', 100);
    if (draftVersion !== undefined && !/^[a-zA-Z0-9-]{1,100}$/.test(draftVersion)) throw new Error('Invalid draft version.');
    return { type, id, prompt, ...(draftVersion === undefined ? {} : { draftVersion }) };
  }
  if (['select', 'launch', 'terminal', 'copyPrompt', 'openWorktree', 'stop', 'releaseExternal', 'startManaged', 'showSessionDiagnostics', 'cancelQueued', 'reconcileWriter', 'reconcileCapacity'].includes(type)) {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    return { type, id } as ClientMessage;
  }
  if (type === 'openFile' || type === 'openDiff') {
    const id = string('id');
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid task ID.');
    if (type === 'openDiff') {
      const layer = string('layer');
      if (!['combined', 'committed', 'staged', 'unstaged', 'untracked'].includes(layer)) throw new Error('Invalid diff layer.');
      return { type, id, path: string('path', 4096), layer } as ClientMessage;
    }
    return { type, id, path: string('path', 4096) };
  }
  if (type === 'create' || type === 'draft') {
    const provider = string('provider');
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const common = { title: string('title', 120), prompt: string('prompt', 32000), provider, ...(message.brief === undefined ? {} : { brief: parseBrief(message.brief, type === 'draft') }) };
    if (type === 'draft') return { type, ...common } as ClientMessage;
    if (!common.title.trim() || !common.prompt.trim()) throw new Error('Enter a title and task prompt.');
    if (common.brief && !common.brief.goal.trim()) throw new Error('Enter a task goal.');
    if (common.brief && buildTaskPrompt(common.brief) !== common.prompt) throw new Error('The prompt preview does not match the task brief. Refresh before creating the task.');
    return { type, ...common, repository: string('repository', 4096), startingCommit: message.startingCommit === undefined ? undefined : string('startingCommit', 64) || undefined } as ClientMessage;
  }
  throw new Error('Unknown command.');
}
