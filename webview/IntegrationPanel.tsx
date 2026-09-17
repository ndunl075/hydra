import React, { useState } from 'react';
import type { ClientMessage, Task } from '../src/core/model';
import { parseIntegrationCommands, type IntegrationOperation } from '../src/core/integrationModel';
import './integration.css';
export function IntegrationPanel({task,operation,busy,send}:{task:Task;operation?:IntegrationOperation;busy:boolean;send:(message:ClientMessage)=>void}){
  const [checks,setChecks]=useState('[\n  {"executable": "npm.cmd", "args": ["test"]}\n]');
  const [error,setError]=useState<string>();
  const blocked=busy||task.state==='running'||task.state==='external'||task.interface==='official-extension';
  const prepare=()=>{try{const commands=parseIntegrationCommands(JSON.parse(checks));setError(undefined);send({type:'prepareIntegration',id:task.id,checks:commands});}catch(error){setError(error instanceof Error?error.message:String(error));}};
  const action=(type:'promoteIntegration'|'reviewIntegrationResolution'|'copyIntegrationCandidate'|'showIntegrationLog'|'cancelIntegration')=>{if(operation)send({type,id:task.id,operationId:operation.id});};
  return <section className="integration-panel" aria-label="Task integration">
    <div className="section-label">INTEGRATION <span>{task.integrationTarget}</span></div>
    <p className="quiet">Build a separate merge candidate from the exact reviewed commit. Your target checkout stays in place until you promote passed checks.</p>
    <label className="integration-check-label">Acceptance commands<textarea rows={4} spellCheck={false} disabled={blocked} value={checks} onChange={event=>setChecks(event.target.value)} /></label>
    <p className="quiet">These executable/argument records run in the candidate checkout when you prepare it. Choose commands for this project; Git hooks apply. Each check is limited to two minutes.</p>
    {error&&<p className="session-error" role="alert">{error}</p>}
    <button className="secondary" disabled={blocked||!task.reviewedCommit} onClick={prepare}>{operation?'Build fresh candidate':'Prepare integration'}</button>
    {!task.reviewedCommit&&<p className="quiet">Record a reviewed task commit first.</p>}
    {operation&&<>
      <div className={`integration-status integration-${operation.phase}`} role="status"><strong>{operation.phase.replaceAll('-',' ')}</strong><code>{operation.candidateCommit?.slice(0,8)||operation.taskCommit.slice(0,8)}</code></div>
      <p className="quiet">Target at preparation: <code>{operation.targetCommit.slice(0,8)}</code> · Reviewed task: <code>{operation.taskCommit.slice(0,8)}</code></p>
      {operation.error&&<p className="session-error" role="status">{operation.error}</p>}
      <ul className="integration-checks">{operation.checks.map((check,index)=><li key={index}><span className="integration-check-state">{check.status}</span><code title={JSON.stringify([check.executable,...check.args])}>{check.executable} {check.args.join(' ')}</code>{check.exitCode!==undefined&&<span>Exit {check.exitCode??'unavailable'}</span>}</li>)}</ul>
      <div className="task-actions"><button className="secondary" onClick={()=>action('showIntegrationLog')}>Check logs</button><button className="secondary" onClick={()=>action('copyIntegrationCandidate')}>Copy candidate path</button>{operation.phase==='checking'&&<button className="stop-button" onClick={()=>action('cancelIntegration')}>Cancel checks</button>}</div>
      {operation.candidateCommit&&operation.files.map(file=><div className="change-row" key={file.path}><div className="change-path"><span className="file-status">{file.status}</span><span title={file.path}>{file.path}</span><button className="diff-button" disabled={blocked} onClick={()=>send({type:'openIntegrationDiff',id:task.id,operationId:operation.id,path:file.path})}>Review candidate</button></div></div>)}
      {['conflicted','failed','interrupted'].includes(operation.phase)&&<><p className="quiet">The target, task, and candidate are preserved. Resolve and commit the candidate with Git, then review its new tree and rerun acceptance checks.</p><button className="secondary" disabled={blocked} onClick={()=>action('reviewIntegrationResolution')}>Review resolved candidate</button></>}
      {operation.phase==='resolution-review'&&operation.reviewToken&&<button className="primary" disabled={blocked} onClick={()=>send({type:'acceptIntegrationResolution',id:task.id,operationId:operation.id,token:operation.reviewToken!})}>Accept this resolution and rerun checks</button>}
      {operation.phase==='validated'&&<><p className="quiet">Checks passed for this exact candidate. Promotion rechecks task state, target HEAD, and saved/unsaved edits. Changed inputs require a fresh candidate.</p><button className="primary" disabled={blocked} onClick={()=>action('promoteIntegration')}>Promote to {task.integrationTarget}</button></>}
      {operation.phase==='promoted'&&<p className="quiet">Promoted commit <code>{operation.candidateCommit?.slice(0,8)}</code>. Task and candidate retained. Recovery reference: <code>{operation.rollbackRef}</code></p>}
    </>}
  </section>;
}
