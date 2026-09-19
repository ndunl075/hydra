import type { DelegatedVerificationEvidence } from './delegationEvidence';
import type { Task } from './model';

/** Marks only the attempt owned by the interrupted action. Earlier evidence is immutable. */
export function interruptLatestDelegatedVerification(evidence: DelegatedVerificationEvidence): DelegatedVerificationEvidence {
  const copy = structuredClone(evidence);
  const latest = copy.attempts.at(-1);
  if (!latest) return copy;
  for (const check of latest.checks) {
    if (check.status === 'passed') { check.status = 'interrupted'; check.exitCode = null; }
  }
  return copy;
}

/**
 * Commits a completed evidence snapshot only after its durable save succeeds.
 * Publishing and capacity reconciliation deliberately stay outside this small
 * transaction so a failed disk write has no UI or scheduler side effects.
 */
export async function persistDelegatedVerification(
  task: Pick<Task, 'verificationEvidence' | 'updatedAt'>,
  evidence: DelegatedVerificationEvidence,
  save: () => Promise<void>,
  updatedAt: string,
  signal?: AbortSignal
): Promise<DelegatedVerificationEvidence> {
  const previousEvidence = task.verificationEvidence ? structuredClone(task.verificationEvidence) : undefined;
  const previousUpdatedAt = task.updatedAt;
  task.verificationEvidence = structuredClone(evidence);
  task.updatedAt = updatedAt;
  let initialSaveCompleted = false;
  try {
    await save(); initialSaveCompleted = true;
    // Yield one event-loop turn before accepting the passing result. This gives
    // shutdown/abort delivery a final ownership fence between save and action
    // completion; after the final synchronous check no abort can interleave.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    // Shutdown can arrive while the first durable write is in flight. Persist
    // a second, interrupted snapshot before this action settles: the passing
    // record is never the final reloadable state for an aborted action.
    if (signal?.aborted) {
      const interrupted = interruptLatestDelegatedVerification(evidence);
      task.verificationEvidence = structuredClone(interrupted);
      task.updatedAt = new Date().toISOString();
      await save();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      return structuredClone(interrupted);
    }
    return structuredClone(task.verificationEvidence);
  } catch (error) {
    // Before any durable write, a normal rollback is safe. Once the first
    // write completed, retain the interruption in memory so shutdown's final
    // store save has no path back to a passing latest attempt.
    if (!initialSaveCompleted) { task.verificationEvidence = previousEvidence; task.updatedAt = previousUpdatedAt; }
    else if (signal?.aborted) { task.verificationEvidence = interruptLatestDelegatedVerification(evidence); task.updatedAt = new Date().toISOString(); }
    throw error;
  }
}

export interface DelegatedVerificationAction<T = unknown> { controller: AbortController; done: Promise<T> }
export class DelegatedVerificationActionGate {
  private active?: DelegatedVerificationAction;
  start<T>(work: (signal: AbortSignal) => Promise<T>): DelegatedVerificationAction<T> {
    if (this.active) throw new Error('Another delegated verification is already in progress.');
    const controller = new AbortController();
    let done!: Promise<T>;
    done = (async () => { try { return await work(controller.signal); } finally { if (this.active?.done === done) this.active = undefined; } })();
    return this.active = { controller, done };
  }
  async abortAndWait(): Promise<void> { const active = this.active; active?.controller.abort(); await active?.done.catch(() => {}); }
}
