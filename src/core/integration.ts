import { randomBytes } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Task } from './model';
import type { IntegrationCommand, IntegrationOperation } from './integrationModel';
import { parseIntegrationCommands } from './integrationModel';
import { candidatePath, IntegrationStore, validateIntegration } from './integrationStore';
import { OwnershipLock } from './ownership';
import { git } from './git';
import { repositoryRoot, isInside } from './worktrees';
import { parseNameStatus } from './review';
import { runProbe } from './process';
import { delegationIntegrationGate } from './delegationIntegrationGate';
export type IntegrationGuard = (paths: string[]) => void | Promise<void>;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0,8000);
const same = (a: string,b: string) => path.relative(a,b) === '';
function notCancelled(signal?:AbortSignal):void{if(signal?.aborted)throw new Error('Integration checks cancelled. Preserved candidate requires a fresh review.');}
async function common(directory: string): Promise<string> { return realpath((await git(directory,['rev-parse','--path-format=absolute','--git-common-dir'])).trim()); }
async function head(directory: string): Promise<string> { return (await git(directory,['rev-parse','HEAD'])).trim(); }
async function clean(directory: string): Promise<void> {
  if ((await git(directory,['ls-files','-v','-z'])).split('\0').some(entry=>entry&&(entry[0] === 'S'||entry[0] !== entry[0]?.toUpperCase()))) throw new Error('Integration requires a full worktree without skip-worktree or assume-unchanged entries.');
  for (const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
    const location=(await git(directory,['rev-parse','--path-format=absolute','--git-path',name])).trim();
    if(await access(location).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw new Error('Finish the active Git operation before integration.');
  }
  if(await git(directory,['--no-optional-locks','-c','core.fsmonitor=false','status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none'])) throw new Error(`Integration requires a clean saved checkout: ${directory}`);
}
async function inputs(task: Task, tasks: readonly Task[], op?: IntegrationOperation): Promise<{target: string; common: string}> {
  if(task.state === 'discarded')throw new Error('Restore this discarded task before integration.');
  if(task.state === 'running' || task.state === 'external' || task.interface === 'official-extension') throw new Error('Stop the task writer and acknowledge external handback before integration.');
  if(!task.reviewedCommit)throw new Error('Commit and record a reviewed task tree before integration.');
  delegationIntegrationGate(task,tasks);
  const receipt=task.reviewedCommit;
  if(receipt.baseCommit!==task.baseCommit)throw new Error('Reviewed task base changed. Prepare a fresh review.');
  const repository=await realpath(task.repository), worktree=await realpath(task.worktree);
  if(!same(repository,await repositoryRoot(repository))||!same(worktree,await repositoryRoot(worktree)))throw new Error('Integration checkout identity changed.');
  const shared=await common(repository);
  if(!same(shared,await common(worktree)))throw new Error('Task belongs to another repository.');
  if((await git(worktree,['symbolic-ref','--short','HEAD'])).trim()!==task.branch||(await git(repository,['symbolic-ref','--short','HEAD'])).trim()!==task.integrationTarget)throw new Error('Restore the recorded task and target branches before integration.');
  if(await head(worktree)!==receipt.commit||(await git(worktree,['rev-parse',`${receipt.commit}^{tree}`])).trim()!==receipt.tree)throw new Error('Task no longer matches its reviewed commit. Prepare a fresh review.');
  await clean(worktree);await clean(repository);
  const target=await head(repository);
  if(op&&(op.taskCommit!==receipt.commit||op.taskTree!==receipt.tree||op.baseCommit!==receipt.baseCommit||op.targetCommit!==target))throw new Error('Integration inputs changed. Rebuild and revalidate a fresh candidate.');
  return {target,common:shared};
}
async function candidateIdentity(task: Task, op: IntegrationOperation, requireClean=true): Promise<void> {
  validateIntegration(op,[task]);
  const candidate=await realpath(op.candidate);
  if(!same(candidate,op.candidate)||!same(candidate,await repositoryRoot(candidate))||!same(await common(candidate),await common(task.repository))||isInside(await realpath(task.repository),candidate))throw new Error('Integration candidate identity changed. Preserve it for inspection.');
  if(await git(candidate,['symbolic-ref','--quiet','HEAD']).then(()=>true,()=>false))throw new Error('Integration candidate must remain a detached checkout.');
  if(requireClean)await clean(candidate);
}
async function recordCandidate(op: IntegrationOperation): Promise<void> {
  op.candidateCommit=await head(op.candidate);op.candidateTree=(await git(op.candidate,['rev-parse',`${op.candidateCommit}^{tree}`])).trim();
  await git(op.candidate,['merge-base','--is-ancestor',op.targetCommit,op.candidateCommit]);
  await git(op.candidate,['merge-base','--is-ancestor',op.taskCommit,op.candidateCommit]);
  op.files=parseNameStatus(await git(op.candidate,['diff','--name-status','-z','--find-renames','--no-ext-diff','--no-textconv',op.targetCommit,op.candidateCommit,'--']),'combined');
  if(op.files.length>1000)throw new Error('Integration review exceeds 1,000 files. Split the task.');
}
export class Integrations {
  readonly store: IntegrationStore;
  constructor(private readonly directory: string, private readonly changed: (op: IntegrationOperation)=>void = ()=>{}, private readonly tasks: () => readonly Task[] = () => []) { this.store=new IntegrationStore(path.join(directory,'operations')); }
  private async save(op: IntegrationOperation): Promise<void>{op.updatedAt=new Date().toISOString();await this.store.save(op);this.changed(op);}
  private async locked<T>(task:Task,action:()=>Promise<T>):Promise<T>{const shared=await common(task.repository);const lock=new OwnershipLock();await lock.acquire(path.join(shared,'hydra-integration-locks'),shared);try{return await action();}finally{await lock.release();}}
  async prepare(task:Task,commands:IntegrationCommand[],guard:IntegrationGuard,signal?:AbortSignal):Promise<IntegrationOperation>{
    commands=parseIntegrationCommands(commands);
    return this.locked(task,async()=>{
      await guard([task.worktree,task.repository]);const state=await inputs(task,this.tasks());
      if(await git(task.repository,['merge-base','--is-ancestor',task.reviewedCommit!.commit,state.target]).then(()=>true,()=>false))throw new Error('This reviewed commit is already integrated into the target.');
      const id=randomBytes(12).toString('hex'),receipt=task.reviewedCommit!,stamp=new Date().toISOString();
      const op:IntegrationOperation={version:1,id,taskId:task.id,repository:task.repository,taskWorktree:task.worktree,taskBranch:task.branch,targetBranch:task.integrationTarget,baseCommit:receipt.baseCommit,taskCommit:receipt.commit,taskTree:receipt.tree,targetCommit:state.target,candidate:candidatePath(task,id),phase:'preparing',checks:commands.map(command=>({...command,status:'pending'})),files:[],createdAt:stamp,updatedAt:stamp};
      await this.save(op);
      try{
        const parent=await realpath(path.dirname(task.worktree)),directory=path.dirname(op.candidate);
        if(isInside(await realpath(task.repository),directory))throw new Error('Integration candidates must be outside the target checkout.');
        await mkdir(directory,{recursive:true});if(!same(await realpath(directory),path.join(parent,'.hydra-integrations')))throw new Error('Integration candidate directory escapes its expected parent.');
        await guard([task.worktree,task.repository]);await inputs(task,this.tasks(),op);
        await git(task.repository,['worktree','add','--detach',op.candidate,op.targetCommit]);
        try{await git(op.candidate,['merge','--no-ff','--no-edit',op.taskCommit]);}
        catch(error){op.phase=(await git(op.candidate,['ls-files','--unmerged','-z'])).length?'conflicted':'failed';op.error=message(error);await this.save(op);return op;}
        await candidateIdentity(task,op);await recordCandidate(op);
        await this.check(task,op,guard,signal);
      }catch(error){op.phase='failed';op.error=message(error);await this.save(op);}
      return op;
    });
  }
  private async check(task:Task,op:IntegrationOperation,guard:IntegrationGuard,signal?:AbortSignal):Promise<void>{
    notCancelled(signal);
    op.phase='checking';op.error=undefined;op.reviewToken=undefined;op.checks=op.checks.map(check=>({executable:check.executable,args:check.args,status:'pending'}));await this.save(op);
    for(const check of op.checks){
      await guard([task.worktree,task.repository,op.candidate]);await inputs(task,this.tasks(),op);await candidateIdentity(task,op);
      if(await head(op.candidate)!==op.candidateCommit)throw new Error('Candidate commit changed. Review and validate it again.');
      notCancelled(signal);
      check.status='running';await this.save(op);
      notCancelled(signal);
      const result=await runProbe(check.executable,check.args,op.candidate,{timeoutMs:120000,maxBytes:256*1024,signal});
      check.exitCode=result.exitCode;check.stdout=result.stdout;check.stderr=result.stderr;check.error=result.error;
      check.status=result.exitCode===0&&!result.error?'passed':'failed';await this.save(op);
      if(check.status==='failed'){op.phase='failed';op.error='Acceptance check failed. Target and task are preserved; inspect the candidate and logs.';await this.save(op);return;}
    }
    await guard([task.worktree,task.repository,op.candidate]);await inputs(task,this.tasks(),op);await candidateIdentity(task,op);
    if(await head(op.candidate)!==op.candidateCommit||(await git(op.candidate,['rev-parse','HEAD^{tree}'])).trim()!==op.candidateTree)throw new Error('Checks changed the candidate. Review the resulting commit and validate it again.');
    notCancelled(signal);
    op.phase='validated';await this.save(op);
  }
  async reviewResolution(task:Task,op:IntegrationOperation,guard:IntegrationGuard):Promise<void>{
    await this.locked(task,async()=>{
      if(!['conflicted','failed','interrupted'].includes(op.phase))throw new Error('This candidate does not need a resolution review.');
      await guard([task.worktree,task.repository,op.candidate]);await inputs(task,this.tasks(),op);await candidateIdentity(task,op);await recordCandidate(op);
      op.phase='resolution-review';op.reviewToken=randomBytes(12).toString('hex');op.error=undefined;await this.save(op);
    });
  }
  async acceptResolution(task:Task,op:IntegrationOperation,token:string,guard:IntegrationGuard,signal?:AbortSignal):Promise<void>{
    await this.locked(task,async()=>{
      if(op.phase!=='resolution-review'||token!==op.reviewToken)throw new Error('Resolved candidate review expired. Review it again.');
      try{await candidateIdentity(task,op);if(await head(op.candidate)!==op.candidateCommit)throw new Error('Resolved candidate changed. Review it again.');await this.check(task,op,guard,signal);}catch(error){op.phase='failed';op.reviewToken=undefined;op.error=message(error);await this.save(op);}
    });
  }
  async promote(task:Task,op:IntegrationOperation,guard:IntegrationGuard):Promise<void>{
    await this.locked(task,async()=>{
      validateIntegration(op,[task]);if(op.phase!=='validated'||!op.candidateCommit||!op.candidateTree||op.checks.some(check=>check.status!=='passed'||check.exitCode!==0||check.error))throw new Error('A validated candidate with passed acceptance checks is required.');
      await guard([task.worktree,task.repository,op.candidate]);await inputs(task,this.tasks(),op);await candidateIdentity(task,op);
      if(await head(op.candidate)!==op.candidateCommit||(await git(op.candidate,['rev-parse','HEAD^{tree}'])).trim()!==op.candidateTree)throw new Error('Validated candidate changed. Review and validate it again.');
      op.rollbackRef=`refs/hydra/integration-backups/${op.id}`;
      const prior=await git(task.repository,['rev-parse','--verify',op.rollbackRef]).then(value=>value.trim(),()=>undefined);
      if(prior !== undefined && prior !== op.targetCommit) throw new Error('Integration rollback reference changed. Preserve it for inspection.');
      if(prior === undefined) await git(task.repository,['update-ref',op.rollbackRef,op.targetCommit,'0'.repeat(op.targetCommit.length)]);
      op.phase='promoting';await this.save(op);
      try{
        await guard([task.worktree,task.repository,op.candidate]);await inputs(task,this.tasks(),op);
        await git(task.repository,['merge','--ff-only',op.candidateCommit]);
        if(await head(task.repository)!==op.candidateCommit)throw new Error('Target changed during promotion. Preserve the checkout and inspect the rollback reference.');
        op.phase='promoted';op.error=undefined;
        try{await clean(task.repository);}catch(error){op.error=`Commit promoted; native hook or external saved edits require inspection. ${message(error)}`.slice(0,8000);}
        await this.save(op);
      }catch(error){op.phase=await head(task.repository)===op.candidateCommit?'promoted':'interrupted';op.error=message(error);await this.save(op);throw error;}
    });
  }
  async recover(tasks:Task[]):Promise<IntegrationOperation[]>{
    const operations=await this.store.load(tasks);
    for(const op of operations){
      if(!['preparing','checking','promoting','resolution-review'].includes(op.phase))continue;
      const task=tasks.find(task=>task.id===op.taskId)!;
      const completed=op.phase==='promoting'&&op.candidateCommit&&op.candidateTree&&op.rollbackRef&&op.checks.every(check=>check.status==='passed'&&check.exitCode===0&&!check.error)&&await (async()=>{
        try{
          if(!same(await realpath(task.repository),await repositoryRoot(task.repository))||(await git(task.repository,['symbolic-ref','--short','HEAD'])).trim()!==op.targetBranch||await head(task.repository)!==op.candidateCommit||(await git(task.repository,['rev-parse','HEAD^{tree}'])).trim()!==op.candidateTree||(await git(task.repository,['rev-parse','--verify',op.rollbackRef!])).trim()!==op.targetCommit)return false;
          await git(task.repository,['merge-base','--is-ancestor',op.targetCommit,op.candidateCommit!]);await git(task.repository,['merge-base','--is-ancestor',op.taskCommit,op.candidateCommit!]);return true;
        }catch{return false;}
      })();
      if(completed){op.phase='promoted';op.error='Recovered completed promotion. No Git mutation was repeated.';}
      else{op.phase='interrupted';op.reviewToken=undefined;op.error='Previous integration was interrupted. Inspect preserved checkouts and prepare a fresh review; no command or promotion was replayed.';for(const check of op.checks)if(check.status==='running'){check.status='failed';check.error='Check process unavailable after restart.';}}
      await this.save(op);
    }return operations;
  }
}
