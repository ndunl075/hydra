import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {git,createWorktree} from '../src/core/worktrees';
import {Integrations} from '../src/core/integration';
import {parseMessage,type Task} from '../src/core/model';
import {validateIntegration} from '../src/core/integrationStore';
import {delegationIntegrationGate} from '../src/core/delegationIntegrationGate';
const guard=()=>{},check=[{executable:process.execPath,args:['-e','process.exit(0)']}];
async function fixture(){
  const directory=path.resolve('.test-build/integration-fixtures');await mkdir(directory,{recursive:true});const root=await mkdtemp(path.join(directory,'integration-')),repository=path.join(root,'main');await mkdir(repository);
  await git(repository,['init','-b','main']);await git(repository,['config','user.email','integration@example.invalid']);await git(repository,['config','user.name','Integration Test']);await git(repository,['config','core.autocrlf','false']);await writeFile(path.join(repository,'keep.txt'),'base\n');await git(repository,['add','.']);await git(repository,['commit','-m','base']);
  const canonical=await realpath(repository);
  async function task(id:string,file='task.txt',content='task\n'):Promise<Task>{
    const created=await createWorktree(canonical,'Integration',id);await writeFile(path.join(created.worktree,file),content);await git(created.worktree,['add','.']);await git(created.worktree,['commit','-m','Reviewed task']);
    const commit=(await git(created.worktree,['rev-parse','HEAD'])).trim(),tree=(await git(created.worktree,['rev-parse','HEAD^{tree}'])).trim(),stamp=new Date().toISOString();return {id,title:'Integration',prompt:'Task',repository:canonical,...created,provider:'codex',interface:'interactive-cli',state:'idle',createdAt:stamp,updatedAt:stamp,reviewedCommit:{commit,tree,baseCommit:created.baseCommit,reviewedAt:stamp}};
  }
  return {root,repository:canonical,task,integrations:new Integrations(path.join(root,'journal'))};
}
test('independent reviewed tasks validate and promote in order through owning checkout, retaining rollback and task trees',async()=>{
  const f=await fixture();try{
    const first=await f.task('111111111111','one.txt'),second=await f.task('222222222222','two.txt');
    for(const task of [first,second]){
      const before=(await git(f.repository,['rev-parse','HEAD'])).trim(),op=await f.integrations.prepare(task,[{executable:process.execPath,args:['-e',`require('node:fs').accessSync(${JSON.stringify(task===first?'one.txt':'two.txt')})`]}],guard);assert.equal(op.phase,'validated');assert.equal((await git(f.repository,['rev-parse','HEAD'])).trim(),before);
      await f.integrations.promote(task,op,guard);assert.equal(op.phase,'promoted');assert.equal((await git(f.repository,['rev-parse','HEAD'])).trim(),op.candidateCommit);assert.equal((await git(f.repository,['rev-parse',op.rollbackRef!])).trim(),before);assert.equal((await git(task.worktree,['rev-parse','HEAD'])).trim(),task.reviewedCommit!.commit);assert.equal(await readFile(path.join(op.candidate,task===first?'one.txt':'two.txt'),'utf8'),'task\n');
    }
    assert.equal(await readFile(path.join(f.repository,'one.txt'),'utf8'),'task\n');assert.equal(await readFile(path.join(f.repository,'two.txt'),'utf8'),'task\n');assert.equal(await git(f.repository,['status','--porcelain=v1']),'');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('dirty target/task, writers, unsaved guard, changed receipt and candidate reject promotion without discarding work',async()=>{
  const f=await fixture();try{
    const task=await f.task('333333333333'),original=(await git(f.repository,['rev-parse','HEAD'])).trim();
    await writeFile(path.join(f.repository,'keep.txt'),'user edit\n');await assert.rejects(f.integrations.prepare(task,check,guard),/clean saved/);assert.equal(await readFile(path.join(f.repository,'keep.txt'),'utf8'),'user edit\n');await git(f.repository,['restore','keep.txt']);
    await writeFile(path.join(task.worktree,'extra.txt'),'task edit\n');await assert.rejects(f.integrations.prepare(task,check,guard),/clean saved/);await rm(path.join(task.worktree,'extra.txt'));
    task.state='running';await assert.rejects(f.integrations.prepare(task,check,guard),/Stop the task writer/);task.state='idle';
    const op=await f.integrations.prepare(task,check,guard);assert.equal(op.phase,'validated');await assert.rejects(f.integrations.promote(task,op,()=>{throw new Error('Unsaved buffer');}),/Unsaved buffer/);
    await writeFile(path.join(op.candidate,'extra.txt'),'candidate edit\n');await assert.rejects(f.integrations.promote(task,op,guard),/clean saved/);assert.equal(await readFile(path.join(op.candidate,'extra.txt'),'utf8'),'candidate edit\n');await rm(path.join(op.candidate,'extra.txt'));
    await git(task.worktree,['commit','--allow-empty','-m','external change']);await assert.rejects(f.integrations.promote(task,op,guard),/no longer matches/);assert.equal((await git(f.repository,['rev-parse','HEAD'])).trim(),original);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('native conflicts retain checkouts, require committed resolution review and rerun chosen acceptance commands',async()=>{
  const f=await fixture();try{
    const task=await f.task('444444444444','keep.txt','task side\n');await writeFile(path.join(f.repository,'keep.txt'),'target side\n');await git(f.repository,['add','.']);await git(f.repository,['commit','-m','target change']);const before=(await git(f.repository,['rev-parse','HEAD'])).trim();
    const commands=[{executable:process.execPath,args:['-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('keep.txt','utf8'),'resolved\\n')"]}],op=await f.integrations.prepare(task,commands,guard);assert.equal(op.phase,'conflicted');await assert.rejects(f.integrations.promote(task,op,guard),/validated/);assert.equal(await readFile(path.join(f.repository,'keep.txt'),'utf8'),'target side\n');assert.equal(await readFile(path.join(task.worktree,'keep.txt'),'utf8'),'task side\n');
    await writeFile(path.join(op.candidate,'keep.txt'),'resolved\n');await git(op.candidate,['add','.']);await git(op.candidate,['commit','-m','Resolve reviewed candidate']);await f.integrations.reviewResolution(task,op,guard);assert.equal(op.phase,'resolution-review');assert.equal((await git(f.repository,['rev-parse','HEAD'])).trim(),before);await assert.rejects(f.integrations.acceptResolution(task,op,'0'.repeat(24),guard),/expired/);
    await git(op.candidate,['commit','--allow-empty','-m','Changed after review']);await f.integrations.acceptResolution(task,op,op.reviewToken!,guard);assert.equal(op.phase,'failed');assert.equal(op.reviewToken,undefined);await f.integrations.reviewResolution(task,op,guard);
    await f.integrations.acceptResolution(task,op,op.reviewToken!,guard);assert.equal(op.phase,'validated');assert.equal(op.checks[0]!.status,'passed');await f.integrations.promote(task,op,guard);assert.equal(await readFile(path.join(f.repository,'keep.txt'),'utf8'),'resolved\n');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('failed, cancelled and mutating checks retain logs and cannot promote',async()=>{
  const f=await fixture();try{
    const task=await f.task('555555555555'),before=(await git(f.repository,['rev-parse','HEAD'])).trim();
    const failure=await f.integrations.prepare(task,[{executable:process.execPath,args:['-e',"console.error('acceptance failed');process.exit(7)"]}],guard);assert.equal(failure.phase,'failed');assert.equal(failure.checks[0]!.exitCode,7);assert.match(failure.checks[0]!.stderr!,/acceptance failed/);await assert.rejects(f.integrations.promote(task,failure,guard),/validated/);
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const cancellation=new Integrations(path.join(f.root,'cancellation-journal'),operation=>{if(operation.phase==='checking'&&operation.checks[0]?.status==='running'&&!timer)timer=setTimeout(()=>controller.abort(),350);});const cancelled=await cancellation.prepare(task,[{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}],guard,controller.signal);clearTimeout(timer);assert.equal(cancelled.phase,'failed');assert.equal(cancelled.checks[0]!.status,'failed');
    const mutated=await f.integrations.prepare(task,[{executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('unreviewed.txt','change')"]}],guard);assert.equal(mutated.phase,'failed');assert.match(mutated.error!,/clean saved/);assert.equal(await readFile(path.join(mutated.candidate,'unreviewed.txt'),'utf8'),'change');assert.equal((await git(f.repository,['rev-parse','HEAD'])).trim(),before);
    const preCancelled=new AbortController();preCancelled.abort();const neverRan=await f.integrations.prepare(task,[{executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('should-not-exist.txt','bad')"]}],guard,preCancelled.signal);assert.equal(neverRan.phase,'failed');assert.equal(neverRan.checks[0]!.status,'pending');await assert.rejects(readFile(path.join(neverRan.candidate,'should-not-exist.txt')),{code:'ENOENT'});
    const finalCancellation=new AbortController();let candidateGuards=0;const late=await f.integrations.prepare(task,check,paths=>{if(paths.length===3&&++candidateGuards===2)finalCancellation.abort();},finalCancellation.signal);assert.equal(late.checks[0]!.status,'passed');assert.equal(late.phase,'failed');assert.match(late.error!,/cancelled/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('target movement and replaced rollback references refuse stale promotion; restart never replays checks or promotion',async()=>{
  const f=await fixture();try{
    const task=await f.task('666666666666'),op=await f.integrations.prepare(task,check,guard);await git(f.repository,['commit','--allow-empty','-m','target moved']);await assert.rejects(f.integrations.promote(task,op,guard),/inputs changed/);
    const fresh=await f.integrations.prepare(task,check,guard);await git(f.repository,['update-ref',`refs/hydra/integration-backups/${fresh.id}`,task.reviewedCommit!.commit]);await assert.rejects(f.integrations.promote(task,fresh,guard),/rollback reference changed/);await git(f.repository,['update-ref','-d',`refs/hydra/integration-backups/${fresh.id}`]);
    fresh.phase='promoting';await f.integrations.store.save(fresh);const recovered=await f.integrations.recover([task]);assert.equal(recovered.find(value=>value.id===fresh.id)!.phase,'interrupted');assert.notEqual((await git(f.repository,['rev-parse','HEAD'])).trim(),fresh.candidateCommit);
    fresh.phase='validated';await f.integrations.promote(task,fresh,guard);fresh.phase='promoting';await f.integrations.store.save(fresh);assert.equal((await f.integrations.recover([task])).find(value=>value.id===fresh.id)!.phase,'promoted');
    const invalid={...fresh,candidate:path.join(f.root,'escape')};assert.throws(()=>validateIntegration(invalid,[task]),/journal/i);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('integration lock is shared across profile journals and malformed structured commands are refused',async()=>{
  const f=await fixture();try{
    const task=await f.task('777777777777');let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>entered=resolve);let calls=0;
    const first=f.integrations.prepare(task,check,async()=>{if(++calls===1){entered();await gate;}});await ready;await assert.rejects(new Integrations(path.join(f.root,'another-profile')).prepare(task,check,guard),/own|lock|already/i);release();assert.equal((await first).phase,'validated');
    assert.throws(()=>parseMessage({type:'prepareIntegration',id:task.id,checks:[]}),/command/i);assert.throws(()=>parseMessage({type:'prepareIntegration',id:task.id,checks:[{executable:'npm.cmd',args:['test & echo unsafe']}]}),/shell|character|shim/i);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('delegated children block candidate preparation until evidence is current and passing; combined checks still decide promotion',async()=>{
  const f=await fixture();try{
    const parent=await f.task('888888888888'),child=await f.task('999999999999');
    child.delegation={parentId:parent.id,runId:'aaaaaaaaaaaa',childKey:'parser',dispatchKey:'a'.repeat(24),dependencies:[]};
    const evidence=JSON.parse(await readFile(path.resolve('tests/fixtures/delegation-combined-acceptance/verification-evidence.json'),'utf8'));
    const attach=(status:'passed'|'failed'|'interrupted'='passed',stale=false)=>{
      const value=structuredClone(evidence);value.attempts[0].checkedCommit=stale?'b'.repeat(40):child.reviewedCommit!.commit;value.attempts[0].checkedTree=child.reviewedCommit!.tree;value.attempts[0].checks[0].status=status;value.attempts[0].checks[0].exitCode=status==='passed'?0:null;child.verificationEvidence=value;
    };
    const integrations=new Integrations(path.join(f.root,'delegated-journal'),()=>{},()=>[parent,child]);
    await assert.rejects(integrations.prepare(parent,check,guard),/requires retained verification evidence/);
    attach('passed',true);await assert.rejects(integrations.prepare(parent,check,guard),/stale/);
    attach('failed');await assert.rejects(integrations.prepare(parent,check,guard),/did not pass/);
    attach('interrupted');await assert.rejects(integrations.prepare(parent,check,guard),/interrupted/);
    attach();child.state='interrupted';await assert.rejects(integrations.prepare(parent,check,guard),/prerequisite.*interrupted/);child.state='idle';
    child.state='running';await assert.rejects(integrations.prepare(parent,check,guard),/prerequisite.*active/);child.state='idle';
    child.schedule={state:'queued',dependencies:[],artifacts:[],request:{type:'startManaged'}};await assert.rejects(integrations.prepare(parent,check,guard),/prerequisite.*queued/);child.schedule={state:'finished',dependencies:[],artifacts:[],uncertain:true};await assert.rejects(integrations.prepare(parent,check,guard),/prerequisite.*uncertain/);child.schedule=undefined;
    const failedCombined=await integrations.prepare(parent,[{executable:process.execPath,args:['-e','process.exit(3)']}],guard);assert.equal(failedCombined.phase,'failed');assert.equal(failedCombined.checks[0]!.status,'failed');assert.equal(await readFile(path.join(failedCombined.candidate,'task.txt'),'utf8'),'task\n');
    const validated=await integrations.prepare(parent,check,guard);assert.equal(validated.phase,'validated');
    child.state='discarded';await assert.rejects(integrations.promote(parent,validated,guard),/prerequisite.*discarded/);assert.equal(validated.phase,'validated');assert.equal(await readFile(path.join(validated.candidate,'task.txt'),'utf8'),'task\n');child.state='idle';
    child.verificationEvidence=undefined;await assert.rejects(integrations.promote(parent,validated,guard),/requires retained verification evidence/);assert.equal(validated.phase,'validated');assert.throws(()=>delegationIntegrationGate(parent,[parent,child]),/requires retained verification evidence/);
    attach();await git(f.repository,['commit','--allow-empty','-m','target moved']);await assert.rejects(integrations.promote(parent,validated,guard),/inputs changed/);assert.equal(validated.phase,'validated');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
