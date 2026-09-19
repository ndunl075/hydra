import { lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceAtomic } from './atomicFile';
import { id, record } from './delegationContext';
import { parseDelegationContextRequest, type ContextRequestBinding, type DelegationContextRequest } from './delegationContextRequests';
import { parseDelegationResultReceipt, type DelegationResultReceipt, type ResultReceiptBinding } from './delegationResults';
import { boundDelegationGraphEventHistory, parseDelegationGraphEvent, type DelegationGraphEvent } from './delegationGraphEvents';

/** Bounded, immutable facts for one parent/run. It never reads a worktree or launches work. */
interface StoredContext { binding: ContextRequestBinding; receipt: DelegationContextRequest; }
export interface ContextSourceReference { id: string; path: string; revision: string; sha256: string }
export type ContextIngressRefusal = 'invalid-request' | 'out-of-scope' | 'size-limit' | 'stale-source' | 'conflict';
export type ContextIngressOutcome =
  | { version: 1; status: 'selected'; selected: ContextSourceReference[] }
  | { version: 1; status: 'refused'; refusal: ContextIngressRefusal };
interface StoredContextOutcome { requestKey: string; requestSha256: string; outcome: ContextIngressOutcome; }
interface StoredResult { binding: ResultReceiptBinding; receipt: DelegationResultReceipt; }
export interface DelegationOrchestrationRecord { version: 1; parentId: string; runId: string; nextSequence: number; events: DelegationGraphEvent[]; contextRequests: StoredContext[]; contextOutcomes: StoredContextOutcome[]; results: StoredResult[]; }
export interface DelegationOrchestrationProjection { events: DelegationGraphEvent[]; contextRequests: DelegationContextRequest[]; results: DelegationResultReceipt[]; contextOutcomes?: Record<string, ContextIngressOutcome>; }
const maxBytes = 1024 * 1024, maxReceipts = 64;
const clone = <T>(value: T): T => structuredClone(value);

function parseRecord(value: unknown, parentId: string, runId: string): DelegationOrchestrationRecord {
  const item = record(value, ['version', 'parentId', 'runId', 'nextSequence', 'events', 'contextRequests', 'contextOutcomes', 'results']);
  const rawOutcomes = item.contextOutcomes ?? [];
  if (item.version !== 1 || item.parentId !== parentId || item.runId !== runId || !Number.isSafeInteger(item.nextSequence) || (item.nextSequence as number) < 1 || !Array.isArray(item.events) || !Array.isArray(item.contextRequests) || !Array.isArray(rawOutcomes) || !Array.isArray(item.results) || item.contextRequests.length > maxReceipts || rawOutcomes.length > maxReceipts || item.results.length > maxReceipts) throw new Error('Invalid delegation orchestration journal. Original data was retained.');
  const bounded = boundDelegationGraphEventHistory(item.events);
  if (bounded.evicted.length) throw new Error('Delegation orchestration journal exceeds retained event history. Original data was retained.');
  // Context/result receipts require their original host bindings. They are revalidated at ingress;
  // load retains their canonical immutable bytes and refuses malformed envelopes here.
  const exact = (entry: unknown, fields: string[]) => record(entry, fields);
  const contexts = item.contextRequests.map(entry => { const x = exact(entry, ['binding','receipt']); const receipt = parseDelegationContextRequest(x.receipt, x.binding as ContextRequestBinding); if (receipt.parentId !== parentId || receipt.runId !== runId) throw new Error('Cross-run context receipt in journal.'); return { binding: clone(x.binding as ContextRequestBinding), receipt }; });
  const outcomes = rawOutcomes.map(entry => {
    const x = exact(entry, ['requestKey', 'requestSha256', 'outcome']), request = contexts.find(context => context.receipt.requestKey === x.requestKey);
    if (!request || x.requestSha256 !== request.receipt.sha256) throw new Error('Context outcome does not match its immutable request.');
    const outcome = record(x.outcome, ['version', 'status', 'selected', 'refusal']);
    if (outcome.version !== 1 || !['selected', 'refused'].includes(outcome.status as string)) throw new Error('Invalid context ingress outcome.');
    if (outcome.status === 'selected') {
      if (!Array.isArray(outcome.selected) || outcome.refusal !== undefined || JSON.stringify(outcome.selected) !== JSON.stringify(request.receipt.requested.map(({ id, path, revision, sha256 }) => ({ id, path, revision, sha256 })))) throw new Error('Invalid selected context outcome.');
      return { requestKey: request.receipt.requestKey, requestSha256: request.receipt.sha256, outcome: { version: 1 as const, status: 'selected' as const, selected: clone(outcome.selected as ContextSourceReference[]) } };
    }
    if (outcome.selected !== undefined || !['invalid-request', 'out-of-scope', 'size-limit', 'stale-source', 'conflict'].includes(outcome.refusal as string)) throw new Error('Invalid refused context outcome.');
    return { requestKey: request.receipt.requestKey, requestSha256: request.receipt.sha256, outcome: { version: 1 as const, status: 'refused' as const, refusal: outcome.refusal as ContextIngressRefusal } };
  });
  const results = item.results.map(entry => { const x = exact(entry, ['binding','receipt']); const receipt = parseDelegationResultReceipt(x.receipt, x.binding as ResultReceiptBinding); if (receipt.parentId !== parentId || receipt.runId !== runId) throw new Error('Cross-run result receipt in journal.'); return { binding: clone(x.binding as ResultReceiptBinding), receipt }; });
  const events = bounded.events.map(parseDelegationGraphEvent);
  if (new Set(events.map(event => event.id)).size !== events.length || new Set(contexts.map(entry => entry.receipt.requestKey)).size !== contexts.length || new Set(outcomes.map(entry => entry.requestKey)).size !== outcomes.length || new Set(results.map(entry => entry.receipt.sha256)).size !== results.length) throw new Error('Duplicate immutable delegation orchestration receipt.');
  if (events.some(event => event.sequence >= (item.nextSequence as number))) throw new Error('Invalid delegation event sequence history.'); return { version: 1, parentId, runId, nextSequence: item.nextSequence as number, events, contextRequests: contexts, contextOutcomes: outcomes, results };
}

export class DelegationOrchestrationJournal {
  private queue = new Map<string, Promise<void>>();
  constructor(private readonly directory: string, private readonly assertOwner: () => Promise<void> = async () => {}) {}
  private key(parentId: string, runId: string) { return `${id(parentId)}-${id(runId)}`; }
  private file(parentId: string, runId: string) { return path.join(this.directory, `orchestration-${this.key(parentId, runId)}.json`); }
  private async read(parentId: string, runId: string): Promise<DelegationOrchestrationRecord> {
    const file = this.file(parentId, runId);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid delegation orchestration journal storage. Original data was retained.'); const bytes = await readFile(file); if (bytes.length > maxBytes) throw new Error('Delegation orchestration journal exceeds its size bound.'); return parseRecord(JSON.parse(bytes.toString('utf8')), parentId, runId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, parentId, runId, nextSequence: 1, events: [], contextRequests: [], contextOutcomes: [], results: [] }; throw error; }
  }
  private async save(value: DelegationOrchestrationRecord): Promise<void> {
    const file = this.file(value.parentId, value.runId), bytes = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(bytes, 'utf8') > maxBytes) throw new Error('Delegation orchestration journal exceeds its size bound.');
    await mkdir(this.directory, { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await this.assertOwner(); await replaceAtomic(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  private mutate<T>(parent: string, run: string, fn: (value: DelegationOrchestrationRecord) => T): Promise<T> {
    const parentId = id(parent), runId = id(run), key = this.key(parentId, runId), operation = (this.queue.get(key) || Promise.resolve()).then(async () => {
      await mkdir(this.directory, { recursive: true }); const lock = `${this.file(parentId, runId)}.lock`, token = randomUUID();
      await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Delegation orchestration run has another writer or a retained lock. Reconcile ownership before retrying.'); throw error; });
      try { const next = clone(await this.read(parentId, runId)), result = fn(next); await this.save(next); return clone(result); }
      finally { if (await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {}); }
    });
    this.queue.set(key, operation.then(() => {}, () => {})); return operation;
  }
  async load(parentId: string, runId: string): Promise<DelegationOrchestrationProjection> { const value = await this.read(id(parentId), id(runId)); const outcomes = Object.fromEntries(value.contextOutcomes.map(entry => [entry.requestKey, entry.outcome])); return clone({ events: value.events, contextRequests: value.contextRequests.map(entry => entry.receipt), ...(Object.keys(outcomes).length ? { contextOutcomes: outcomes } : {}), results: value.results.map(entry => entry.receipt) }); }
  async appendEvent(value: unknown): Promise<DelegationGraphEvent> {
    const raw = record(value, ['version','id','sequence','occurredAt','kind','parentId','runId','from','to','provenance']); if (raw.version !== 1) throw new Error('Unsupported delegation graph event schema.'); const parentId = id(raw.parentId), runId = id(raw.runId);
    return this.mutate(parentId, runId, journal => { const prior = journal.events.find(item => item.id === raw.id); if (prior) { const canonical = { ...prior } as Record<string, unknown>; delete canonical.sequence; if (raw.sequence !== undefined || JSON.stringify(canonical) !== JSON.stringify(raw)) throw new Error('Conflicting delegation event identity. Original record was retained.'); return prior; } if (raw.sequence !== undefined) throw new Error('Delegation event sequence is assigned only by the journal.'); const event = parseDelegationGraphEvent({ ...raw, sequence: journal.nextSequence }); const next = boundDelegationGraphEventHistory([...journal.events, event]); journal.events = next.events; journal.nextSequence++; return event; });
  }
  async appendContextRequest(value: unknown, binding: ContextRequestBinding): Promise<DelegationContextRequest> {
    const receipt = parseDelegationContextRequest(value, binding);
    return this.mutate(receipt.parentId, receipt.runId, record => { const previous = record.contextRequests.find(item => item.receipt.requestKey === receipt.requestKey); if (previous) { if (previous.receipt.sha256 !== receipt.sha256) throw new Error('Conflicting context request identity. Original record was retained.'); return previous.receipt; } record.contextRequests.push({ binding: clone(binding), receipt }); return receipt; });
  }
  async contextOutcome(request: DelegationContextRequest, binding: ContextRequestBinding, outcome: ContextIngressOutcome): Promise<ContextIngressOutcome> {
    return this.mutate(request.parentId, request.runId, journal => {
      const stored = journal.contextRequests.find(entry => entry.receipt.requestKey === request.requestKey);
      if (!stored || stored.receipt.sha256 !== request.sha256 || JSON.stringify(stored.binding) !== JSON.stringify(binding)) throw new Error('Context outcome requires its recorded host-bound request.');
      const previous = journal.contextOutcomes.find(entry => entry.requestKey === request.requestKey);
      // A concurrent caller may have observed a different source state before
      // this mutation acquired the run lock. The first durable decision wins.
      if (previous) return previous.outcome;
      journal.contextOutcomes.push({ requestKey: request.requestKey, requestSha256: request.sha256, outcome: clone(outcome) });
      return outcome;
    });
  }
  async appendResult(value: unknown, binding: ResultReceiptBinding): Promise<DelegationResultReceipt> {
    const receipt = parseDelegationResultReceipt(value, binding);
    return this.mutate(receipt.parentId, receipt.runId, record => { const previous = record.results.find(item => item.receipt.childKey === receipt.childKey); if (previous) { if (previous.receipt.sha256 !== receipt.sha256) throw new Error('Conflicting child result receipt. Original record was retained.'); return previous.receipt; } record.results.push({ binding: clone(binding), receipt }); return receipt; });
  }
}
