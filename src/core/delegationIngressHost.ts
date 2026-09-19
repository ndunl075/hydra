import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DelegationDispatchStore } from './delegationDispatch';
import { DelegationResultIngress } from './delegationResultIngress';
import type { ParentReviewSource } from './delegationParentReview';
import { DelegationStore } from './delegationStore';
import { ingressDelegationContextRequest, type ContextIngressReceipt } from './delegationContextIngress';
import { parseDelegationContextRequest } from './delegationContextRequests';
import { DelegationOrchestrationJournal } from './delegationOrchestrationJournal';
import { digest, scopePath, type ContextManifest } from './delegationContext';
import { git, gitBytes } from './git';
import { repositoryRoot, isInside } from './worktrees';
import type { Task } from './model';

export interface DelegationIngressResult {
  receipt: Awaited<ReturnType<DelegationResultIngress['receive']>>;
  binding: Parameters<DelegationResultIngress['receive']>[1]['binding'];
  occurredAt?: string;
}

/**
 * Host-only adapter for D1 ingress.  Callers provide an opaque request/result
 * payload and a child task ID; every authority-bearing field comes from saved
 * host records. Manifest SHA-256 values cover recorded excerpts, not whole
 * worktree files. Source observations are made from the owning Git checkout.
 */
export class DelegationIngressHost {
  constructor(
    private readonly tasks: () => readonly Task[],
    private readonly decisions: DelegationStore,
    private readonly dispatches: DelegationDispatchStore,
    private readonly journal: DelegationOrchestrationJournal,
    private readonly assertSourceReady: (child: Task) => Promise<void> = async () => {},
  ) {}

  private child(taskId: string): Task {
    const child = this.tasks().find(task => task.id === taskId);
    if (!child?.delegation) throw new Error('Only a saved delegated child can use ingress.');
    const parent = this.tasks().find(task => task.id === child.delegation!.parentId);
    if (!parent || parent.delegation) throw new Error('Delegated child parent is unavailable.');
    return child;
  }
  private async manifest(child: Task): Promise<ContextManifest> {
    const link = child.delegation!;
    const run = await this.decisions.load(link.parentId, link.runId);
    const manifest = run.decisions.flatMap(decision => decision.manifests).find(item => item.child.key === link.childKey);
    if (!manifest || manifest.child.parentId !== link.parentId || manifest.child.runId !== link.runId || manifest.child.baseCommit !== child.baseCommit || JSON.stringify(manifest.child.dependencies) !== JSON.stringify(this.dependencyKeys(child))) throw new Error('Saved child does not match its durable delegation decision.');
    return manifest;
  }
  private dependencyKeys(child: Task): string[] {
    const link = child.delegation!;
    return link.dependencies.map(taskId => {
      const dependency = this.tasks().find(task => task.id === taskId);
      if (!dependency?.delegation || dependency.delegation.parentId !== link.parentId || dependency.delegation.runId !== link.runId) throw new Error('Delegated child dependency is unavailable.');
      return dependency.delegation.childKey;
    });
  }
  private async observeSource(child: Task, source: ContextManifest['instructions'][number]): Promise<{ path: string; revision: string; sha256: string } | undefined> {
    try {
      const relative = scopePath(source.path);
      if (source.revision !== child.baseCommit || digest(source.content) !== source.sha256) return undefined;
      const root = await realpath(child.worktree), repository = await realpath(child.repository);
      if (root !== await repositoryRoot(root) || repository !== await repositoryRoot(repository)) return undefined;
      const [worktreeCommon, repositoryCommon, branch] = await Promise.all([
        git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(root, ['symbolic-ref', '--short', 'HEAD']),
      ]);
      if (await realpath(worktreeCommon.trim()) !== await realpath(repositoryCommon.trim()) || branch.trim() !== child.branch) return undefined;
      const oid = (await git(root, ['rev-parse', '--verify', `${source.revision}:${relative}`])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(oid) || (await git(root, ['cat-file', '-t', oid])).trim() !== 'blob') return undefined;
      const length = Number((await git(root, ['cat-file', '-s', oid])).trim());
      if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) return undefined;
      const recorded = await gitBytes(root, ['cat-file', 'blob', oid]);
      if (recorded.length !== length) return undefined;
      const candidate = path.resolve(root, ...relative.split('/'));
      if (!isInside(root, candidate) || await realpath(candidate) !== candidate) return undefined;
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== length) return undefined;
      const current = await readFile(candidate);
      if (!current.equals(recorded)) return undefined;
      const content = recorded.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(recorded) || !content.includes(source.content)) return undefined;
      return { path: relative, revision: source.revision, sha256: source.sha256 };
    } catch { return undefined; }
  }
  async supplyContext(taskId: string, request: unknown): Promise<ContextIngressReceipt> {
    const child = this.child(taskId);
    const identity = JSON.stringify([child.repository, child.worktree, child.branch, child.baseCommit, child.delegation]);
    const manifest = await this.manifest(child), link = child.delegation!;
    const sources = [...manifest.instructions, ...manifest.interfaces, ...manifest.evidence];
    const binding = {
      parentId: link.parentId, runId: link.runId, childKey: link.childKey,
      writeScope: manifest.child.writeScope, readScope: sources.map(source => source.path),
    };
    // Invalid requests are refused by ingress without touching any source.
    let parsed: ReturnType<typeof parseDelegationContextRequest>;
    try { parsed = parseDelegationContextRequest(request, binding); }
    catch { return ingressDelegationContextRequest(this.journal, request, binding, {}); }
    if ((await this.journal.load(link.parentId, link.runId)).contextOutcomes?.[parsed.requestKey]) {
      return ingressDelegationContextRequest(this.journal, request, binding, {});
    }
    await this.assertSourceReady(child);
    const observed = Object.fromEntries((await Promise.all(parsed.requested.map(async ({ id }) => {
      const source = sources.find(item => item.id === id);
      return [id, source && await this.observeSource(child, source)] as const;
    }))).filter((entry): entry is readonly [string, { path: string; revision: string; sha256: string }] => entry[1] !== undefined));
    await this.assertSourceReady(child);
    const current = this.child(taskId);
    if (JSON.stringify([current.repository, current.worktree, current.branch, current.baseCommit, current.delegation]) !== identity) throw new Error('Delegated child identity changed during context observation.');
    return ingressDelegationContextRequest(this.journal, request, binding, observed);
  }
  async receiveResultWithBinding(taskId: string, result: unknown): Promise<DelegationIngressResult> {
    const child = this.child(taskId), manifest = await this.manifest(child), link = child.delegation!;
    const dispatch = (await this.dispatches.load(link.parentId, link.runId)).find(item => item.childKey === link.childKey);
    const history = await this.journal.load(link.parentId, link.runId);
    const deliveredResults = new Map(history.results.map(receipt => [receipt.childKey, receipt.sha256]));
    const dependencies = this.dependencyKeys(child).map(childKey => {
      const receiptSha256 = deliveredResults.get(childKey);
      if (!receiptSha256) throw new Error('A dependent child result has not been durably delivered.');
      return { childKey, receiptSha256 };
    });
    const binding = { parentId: link.parentId, runId: link.runId, childKey: link.childKey, dispatchKey: link.dispatchKey, baseCommit: child.baseCommit, writeScope: manifest.child.writeScope, dependencies };
    const delivered = await new DelegationResultIngress(this.journal).receiveWithDelivery(result, {
      child, dispatch,
      binding,
    });
    return { receipt: delivered.receipt, binding, ...(delivered.occurredAt === undefined ? {} : { occurredAt: delivered.occurredAt }) };
  }
  async receiveResult(taskId: string, result: unknown) {
    return (await this.receiveResultWithBinding(taskId, result)).receipt;
  }
  /** Derives review inputs from durable host records; callers never supply hashes or bindings. */
  async parentReviewSource(taskId: string): Promise<ParentReviewSource> {
    const child = this.child(taskId), manifest = await this.manifest(child), link = child.delegation!;
    const dispatch = (await this.dispatches.load(link.parentId, link.runId)).find(item => item.childKey === link.childKey);
    const history = await this.journal.load(link.parentId, link.runId);
    const result = history.results.find(item => item.childKey === link.childKey);
    if (!dispatch || !result) throw new Error('A durable dispatch and child result receipt are required before parent review.');
    const dependencies = this.dependencyKeys(child).map(childKey => {
      const receiptSha256 = history.results.find(item => item.childKey === childKey)?.sha256;
      if (!receiptSha256) throw new Error('A dependent child result has not been durably delivered.');
      return { childKey, receiptSha256 };
    });
    return { child, result, binding: { parentId: link.parentId, runId: link.runId, childKey: link.childKey, dispatchKey: link.dispatchKey, baseCommit: child.baseCommit, writeScope: manifest.child.writeScope, dependencies } };
  }
}
