import type { Task } from './model';

/** The scheduler owns this receipt. Provider completion is not verification. */
export interface DelegatedExecutionReceipt {
  version: 1;
  dispatchKey: string;
  binding: string;
  status: 'reserved' | 'starting' | 'sessioned' | 'uncertain' | 'stopped';
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

function binding(task: Task): string {
  return JSON.stringify({ id: task.id, delegation: task.delegation, repository: task.repository,
    worktree: task.worktree, branch: task.branch, baseCommit: task.baseCommit, provider: task.provider,
    modelSelection: task.modelSelection || null, prompt: task.prompt });
}

export function assertDelegatedManagedDispatch(task: Task): void {
  if (!task.delegation || !task.schedule || task.schedule.state !== 'enrolled' || task.schedule.request || task.schedule.uncertain) throw new Error('Delegated child must be explicitly enrolled before managed dispatch.');
  if (task.delegationJournalPending) throw new Error('Delegated assignment journal recovery is pending.');
  if (task.interface !== 'managed-cli' || task.state !== 'idle' || task.sessionId || task.delegationExecution) throw new Error('Delegated managed dispatch requires an idle child without an existing dispatch or session.');
  if (task.schedule.dependencies.length !== task.delegation.dependencies.length || task.schedule.dependencies.some((item, index) => item !== task.delegation!.dependencies[index])) throw new Error('Delegated child dependency binding changed.');
}

export function reserveDelegatedExecution(task: Task, now = new Date().toISOString()): DelegatedExecutionReceipt {
  assertDelegatedManagedDispatch(task);
  return { version: 1, dispatchKey: task.delegation!.dispatchKey, binding: binding(task), status: 'reserved', createdAt: now, updatedAt: now };
}

export function validateDelegatedExecution(task: Task): void {
  const receipt = task.delegationExecution;
  if (!receipt || !task.delegation || receipt.version !== 1 || receipt.dispatchKey !== task.delegation.dispatchKey || receipt.binding !== binding(task) ||
    !['reserved', 'starting', 'sessioned', 'uncertain', 'stopped'].includes(receipt.status) ||
    ![receipt.createdAt, receipt.updatedAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ||
    (receipt.sessionId !== undefined && (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt.sessionId) || receipt.sessionId !== task.sessionId)) ||
    (receipt.status === 'sessioned' && !receipt.sessionId) ||
    Object.keys(receipt).some(key => !['version', 'dispatchKey', 'binding', 'status', 'createdAt', 'updatedAt', 'sessionId'].includes(key))) throw new Error('Invalid or stale delegated execution receipt. Original data has been retained.');
}

export function startDelegatedExecution(task: Task, now = new Date().toISOString()): void {
  validateDelegatedExecution(task);
  if (task.delegationExecution!.status !== 'reserved' || task.sessionId) throw new Error('Delegated initial dispatch has already been attempted. Reconcile it before continuing.');
  task.delegationExecution = { ...task.delegationExecution!, status: 'starting', updatedAt: now };
}

export function acknowledgeDelegatedSession(receipt: DelegatedExecutionReceipt, sessionId: string, now = new Date().toISOString()): DelegatedExecutionReceipt {
  if (receipt.status === 'sessioned' && receipt.sessionId === sessionId) return receipt;
  if (!['starting', 'stopped', 'uncertain'].includes(receipt.status) || receipt.sessionId && receipt.sessionId !== sessionId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) throw new Error('Invalid delegated managed session acknowledgement.');
  return { ...receipt, status: receipt.status === 'starting' ? 'sessioned' : receipt.status, sessionId, updatedAt: now };
}

/** Keep a failed acknowledgement uncertain, never pretend the escaped session vanished. */
export async function recordDelegatedSession(task: Task, sessionId: string, persist: () => Promise<void>): Promise<void> {
  if (!task.delegation) return;
  validateDelegatedExecution(task);
  task.delegationExecution = acknowledgeDelegatedSession(task.delegationExecution!, sessionId);
  try { await persist(); }
  catch (error) {
    task.delegationExecution = { ...task.delegationExecution, status: 'uncertain' };
    if (task.schedule) task.schedule.uncertain = true;
    throw error;
  }
}
