import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { digest, id, overlappingScopes, record } from './delegationContext';
import { parseDelegationPolicy, parseDelegationProposal, prepareDelegation, type DelegationPolicy, type DelegationProposal, type PreparedDelegation } from './delegationPlan';

interface Decision { input: DelegationProposal; policy: DelegationPolicy; sha256: string }
interface Run { version: 1; parentId: string; runId: string; decisions: Decision[] }
const maxBytes = 4 * 1024 * 1024, maxDecisions = 64;
function selectedPolicy(proposal: DelegationProposal, input: DelegationPolicy): DelegationPolicy {
  const policy = parseDelegationPolicy(input);
  const references = new Set(proposal.children.flatMap(child => child.contextRefs));
  policy.context.evidence = policy.context.evidence.filter(item => references.has(item.id));
  policy.models = policy.models.filter(model => model.model === policy.modelSelection?.model);
  return policy;
}
function fingerprint(input: DelegationProposal, policy: DelegationPolicy) { return digest(JSON.stringify({ input, policy })); }

/** Decision storage only. Loading/replaying receipts never launches or resumes a task. */
export class DelegationStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly assertOwner: () => Promise<void>) {}
  private file(parentId: string, runId: string) { return path.join(this.directory, `delegation-${id(parentId)}-${id(runId)}.json`); }
  private async read(parentId: string, runId: string): Promise<{ run: Run; prepared: PreparedDelegation[] }> {
    const file = this.file(parentId, runId);
    let data: unknown;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid delegation storage. Original data was retained.');
      const bytes = await readFile(file);
      if (bytes.length > maxBytes) throw new Error('Delegation storage exceeds its size bound.');
      data = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { run: { version: 1, parentId, runId, decisions: [] }, prepared: [] };
      throw error;
    }
    const input = record(data, ['version', 'parentId', 'runId', 'decisions']);
    if (input.version !== 1 || input.parentId !== parentId || input.runId !== runId || !Array.isArray(input.decisions) || input.decisions.length > maxDecisions) throw new Error('Invalid delegation run. Original data was retained.');
    const run: Run = { version: 1, parentId, runId, decisions: [] }, prepared: PreparedDelegation[] = [], used: string[] = [];
    for (const value of input.decisions) {
      const entry = record(value, ['input', 'policy', 'sha256']), proposal = parseDelegationProposal(entry.input), policy = parseDelegationPolicy(entry.policy);
      if (proposal.parentId !== parentId || proposal.runId !== runId || run.decisions.some(decision => decision.input.id === proposal.id) || entry.sha256 !== fingerprint(proposal, policy)) throw new Error('Invalid delegation receipt. Original data was retained.');
      const priorScopes = run.decisions.flatMap(decision => decision.input.children.flatMap(child => child.writeScope));
      if (proposal.children.some(child => overlappingScopes(child.writeScope, priorScopes))) throw new Error('Recorded delegation decisions conflict across replanning. Original data was retained.');
      prepared.push(prepareDelegation(proposal, policy, used));
      used.push(...proposal.children.map(child => child.key));
      run.decisions.push({ input: proposal, policy, sha256: entry.sha256 as string });
    }
    return { run, prepared };
  }
  async load(parentId: string, runId: string): Promise<{ usedKeys: string[]; decisions: PreparedDelegation[] }> {
    const state = await this.read(parentId, runId);
    return { usedKeys: state.run.decisions.flatMap(decision => decision.input.children.map(child => child.key)), decisions: state.prepared };
  }
  async list(parentId: string): Promise<{ runId: string; usedKeys: string[]; decisions: PreparedDelegation[] }[]> {
    const prefix = `delegation-${id(parentId)}-`;
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const runs = names.filter(name => name.startsWith(prefix) && /^delegation-[a-f0-9]{12}-[a-f0-9]{12}\.json$/.test(name)).map(name => name.slice(prefix.length, -'.json'.length)).sort();
    return Promise.all(runs.map(async runId => ({ runId, ...await this.load(parentId, runId) })));
  }
  recordDecision(value: unknown, inputPolicy: DelegationPolicy): Promise<PreparedDelegation> {
    // Snapshot before waiting: later caller mutations cannot change an accepted request.
    const proposal = parseDelegationProposal(value), policy = selectedPolicy(proposal, inputPolicy), sha256 = fingerprint(proposal, policy);
    const operation = this.queue.then(async () => {
      await this.assertOwner();
      const file = this.file(policy.parentId, policy.runId), lock = `${file}.lock`, token = randomUUID();
      await mkdir(this.directory, { recursive: true });
      await writeFile(lock, token, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Delegation decisions have another writer or a retained lock. Reconcile ownership before retrying.'); throw error; });
      try {
        const { run, prepared } = await this.read(policy.parentId, policy.runId);
        const prior = run.decisions.findIndex(decision => decision.input.id === proposal.id);
        if (prior >= 0) {
          if (run.decisions[prior]!.sha256 !== sha256) throw new Error('This decision ID already records different input or host policy.');
          return structuredClone(prepared[prior]!);
        }
        if (run.decisions.length >= maxDecisions) throw new Error('Delegation decision history is full; it cannot reset the run child count.');
        const used = run.decisions.flatMap(decision => decision.input.children.map(child => child.key));
        const decision = prepareDelegation(proposal, policy, used);
        const priorScopes = run.decisions.flatMap(decision => decision.input.children.flatMap(child => child.writeScope));
        if (proposal.children.some(child => overlappingScopes(child.writeScope, priorScopes))) throw new Error('A recorded child already owns this scope. Writer/result reconciliation is required before overlapping replanning.');
        run.decisions.push({ input: proposal, policy, sha256 });
        const bytes = JSON.stringify(run, null, 2);
        if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Delegation storage exceeds its size bound; no decision was recorded.');
        const temporary = `${file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        try {
          await this.assertOwner();
          if (await readFile(lock, 'utf8') !== token) throw new Error('Delegation decision ownership changed; original run was retained.');
          await replaceAtomic(temporary, file);
        }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
        return decision;
      } finally {
        if (await readFile(lock, 'utf8') === token) await unlink(lock);
      }
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
}
