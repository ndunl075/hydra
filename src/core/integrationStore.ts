import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Task } from './model';
import { parseIntegrationCommands, type IntegrationOperation } from './integrationModel';
const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function candidatePath(task: Pick<Task, 'worktree'>, id: string): string { return path.join(path.dirname(task.worktree), '.hydra-integrations', id); }
export function validateIntegration(value: unknown, tasks: Task[]): IntegrationOperation {
  if (!value || typeof value !== 'object') throw new Error('Invalid integration journal. Original data retained.');
  const op = value as IntegrationOperation, task = tasks.find(item => item.id === op.taskId);
  const phases = ['preparing','conflicted','checking','failed','resolution-review','validated','promoting','promoted','interrupted'];
  if (!task || op.version !== 1 || !/^[a-f0-9]{24}$/.test(op.id) || op.repository !== task.repository || op.taskWorktree !== task.worktree || op.taskBranch !== task.branch || op.targetBranch !== task.integrationTarget || op.candidate !== candidatePath(task, op.id) || !phases.includes(op.phase) || ![op.baseCommit,op.taskCommit,op.taskTree,op.targetCommit].every(oid) || [op.candidateCommit,op.candidateTree].some(item => item !== undefined && !oid(item)) || !Array.isArray(op.files) || op.files.length > 1000 || ![op.createdAt,op.updatedAt].every(item => typeof item === 'string' && Number.isFinite(Date.parse(item))) || (op.reviewToken !== undefined && !/^[a-f0-9]{24}$/.test(op.reviewToken)) || (op.rollbackRef !== undefined && op.rollbackRef !== `refs/hydra/integration-backups/${op.id}`)) throw new Error('Invalid integration journal. Original data retained.');
  parseIntegrationCommands(op.checks);
  if (op.checks.some(check => !['pending','running','passed','failed'].includes(check.status) || [check.stdout,check.stderr,check.error].some(item => item !== undefined && (typeof item !== 'string' || item.length > 300000)) || (check.exitCode !== undefined && check.exitCode !== null && !Number.isSafeInteger(check.exitCode))) || (op.error !== undefined && (typeof op.error !== 'string' || op.error.length > 8000))) throw new Error('Invalid integration check journal. Original data retained.');
  for (const file of op.files) if (!file || typeof file.path !== 'string' || file.path.includes('\0') || path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..') || typeof file.status !== 'string' || file.layer !== 'combined' || (file.beforePath !== undefined && (typeof file.beforePath !== 'string' || path.isAbsolute(file.beforePath) || file.beforePath.includes('\0') || file.beforePath.split(/[\\/]/).includes('..')))) throw new Error('Invalid integration file journal. Original data retained.');
  return op;
}
export class IntegrationStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async load(tasks: Task[]): Promise<IntegrationOperation[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch(error) { if((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: IntegrationOperation[] = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) throw new Error('Unexpected integration journal name. Original data retained.');
      const op = validateIntegration(JSON.parse(await readFile(path.join(this.directory,name),'utf8')),tasks);
      if(name !== `${op.id}.json`) throw new Error('Integration journal identity mismatch. Original data retained.');
      result.push(op);
    }
    return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  save(op: IntegrationOperation): Promise<void> {
    const data = JSON.stringify(op,null,2);
    const operation = this.queue.then(async()=> {
      await mkdir(this.directory,{recursive:true});
      const temporary = path.join(this.directory,`${op.id}-${randomBytes(8).toString('hex')}.tmp`);
      await writeFile(temporary,data,{flag:'wx'}); await rename(temporary,path.join(this.directory,`${op.id}.json`));
    }); this.queue = operation.catch(()=>{}); return operation;
  }
}
