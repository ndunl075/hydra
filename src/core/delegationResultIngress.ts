import { assertDelegatedVerificationGate } from './delegationEvidence';
import type { DelegationDispatch } from './delegationDispatch';
import { DelegationOrchestrationJournal } from './delegationOrchestrationJournal';
import { prepareDelegationResult, type DelegationResultReceipt, type ResultReceiptBinding } from './delegationResults';
import type { Task } from './model';

/** The host-owned facts required before a child result can enter the parent journal. */
export interface DelegationResultIngressSource {
  child: Pick<Task, 'id' | 'baseCommit' | 'delegation' | 'reviewedCommit' | 'verificationEvidence'>;
  /** Captured from the recorded dispatch; it is never supplied by provider output. */
  binding: ResultReceiptBinding;
  /** A host-loaded durable dispatch receipt. A copied child field is insufficient. */
  dispatch?: DelegationDispatch;
}

function assertRecordedDispatch(source: DelegationResultIngressSource): void {
  const { child, binding, dispatch } = source;
  if (!child.delegation) throw new Error('Only a recorded delegated child can deliver a result receipt.');
  if (binding.parentId !== child.delegation.parentId || binding.runId !== child.delegation.runId || binding.childKey !== child.delegation.childKey || binding.dispatchKey !== child.delegation.dispatchKey || binding.baseCommit !== child.baseCommit) {
    throw new Error('Result receipt binding does not match the recorded child dispatch.');
  }
  if (!dispatch || dispatch.status !== 'materialized' || dispatch.parentId !== child.delegation.parentId || dispatch.runId !== child.delegation.runId || dispatch.childKey !== child.delegation.childKey || dispatch.dispatchKey !== child.delegation.dispatchKey || dispatch.baseCommit !== child.baseCommit) {
    throw new Error('A matching durable materialized dispatch receipt is required before result delivery.');
  }
  if (!child.reviewedCommit || child.reviewedCommit.baseCommit !== child.baseCommit) throw new Error('A reviewed child commit from the recorded base is required before result delivery.');
}

/**
 * Accepts a compact child result only after the host's saved dispatch, review,
 * and verification records agree. Provider completion text is deliberately not
 * an input to this API.
 */
export class DelegationResultIngress {
  constructor(private readonly journal: DelegationOrchestrationJournal) {}

  async receive(value: unknown, source: DelegationResultIngressSource): Promise<DelegationResultReceipt> {
    assertRecordedDispatch(source);
    assertDelegatedVerificationGate(source.child);
    const receipt = prepareDelegationResult(value, source.binding);
    if (receipt.commit !== source.child.reviewedCommit!.commit || receipt.tree !== source.child.reviewedCommit!.tree) {
      throw new Error('Result receipt commit or tree does not match the reviewed child result.');
    }
    // The saved verification gate attests the reviewed commit, but its artifacts
    // do not carry SHA-256 digests. Until a host-derived evidence binding exists,
    // no caller-supplied validation or evidence claim can be made durable.
    if (receipt.validations.length || receipt.evidence.length) {
      throw new Error('Result validation and evidence claims require host-attested references.');
    }
    // appendResult is atomic and idempotent. This method does not alter the
    // child record, so a failed journal save leaves the recoverable source intact.
    return this.journal.appendResult(receipt, source.binding);
  }
}
