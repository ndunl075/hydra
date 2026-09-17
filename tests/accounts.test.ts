import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { accountRpc,CodexAccountFlow,publicCodexAccount,publicClaudeAccount,supportedAccountVersion,loginUrl,type AccountState,type AccountRpc } from '../src/core/accountSetup';
const account={account:{type:'chatgpt',email:'user@example.invalid',planType:'plus'},requiresOpenaiAuth:true};
test('only pinned public auth contracts are accepted; Claude exit status does not promise a subscription',()=>{
  assert.equal(supportedAccountVersion('claude','2.1.270 (Claude Code)'),true);assert.equal(supportedAccountVersion('codex','codex-cli 0.154.0\n'),true);
  for(const version of ['0.154.1','0.154.0-custom','0.154.01'])assert.equal(supportedAccountVersion('codex',version),false);
  assert.equal(publicClaudeAccount(0).status,'signed-in');assert.match(publicClaudeAccount(0).text,/entitlement.*not been tested/);assert.equal(publicClaudeAccount(1).status,'signed-out');assert.throws(()=>publicClaudeAccount(null));assert.throws(()=>publicClaudeAccount(0,'timeout'));
});
test('Claude public auth mode distinguishes Claude.ai, API credentials and unknown schema without retaining identities',()=>{
  const value={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'private@example.invalid',orgId:'private-org',subscriptionType:'private-plan'};
  const subscription=publicClaudeAccount(0,undefined,JSON.stringify(value));assert.equal(subscription.status,'signed-in');assert.match(subscription.text,/Claude.ai account/);assert.ok(!JSON.stringify(subscription).includes('private'));
  assert.equal(publicClaudeAccount(0,undefined,JSON.stringify({...value,authMethod:'api_key'})).status,'other');assert.equal(publicClaudeAccount(0,undefined,JSON.stringify({...value,apiProvider:'bedrock'})).status,'other');assert.equal(publicClaudeAccount(0,undefined,JSON.stringify({...value,authMethod:'future-mode'})).status,'other');
  assert.match(publicClaudeAccount(0,undefined,'malformed').text,/Account type.*not been tested/);assert.throws(()=>publicClaudeAccount(1,undefined,JSON.stringify(value)),/inconsistent/);
});
function fixture(){
  const calls:Array<{method:string;params:unknown}>=[],states:AccountState[]=[],urls:string[]=[];
  let notify!:(method:string,value:unknown)=>void,closed=0,failLogin=false;
  const flow=new CodexAccountFlow(callback=>{notify=callback;return {async request(method,params){calls.push({method,params});if(method==='initialize')return {};if(method==='account/read')return account;if(method==='account/login/start'){if(failLogin)throw new Error('fixture failure');return {type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/authorize?state=private'};}return {status:'canceled'};},async close(){closed++;}};},state=>states.push(state),async url=>{urls.push(url);return true;});
  return {flow,calls,states,urls,notify:(value:unknown)=>notify('account/login/completed',value),closed:()=>closed,fail:()=>{failLogin=true;},retry:()=>{failLogin=false;}};
}
test('account setup is passive until invoked, refresh requests only public state and retains no identity',async()=>{
  const f=fixture();assert.equal(f.calls.length,0);await f.flow.refresh();assert.deepEqual(f.calls.map(call=>call.method),['initialize','account/read']);assert.deepEqual(f.calls[1]!.params,{refreshToken:false});assert.equal(f.states.at(-1)!.status,'signed-in');assert.ok(!JSON.stringify(f.states).includes('user@example.invalid'));assert.equal(f.urls.length,0);assert.equal(f.closed(),1);
});
test('ChatGPT completion verifies account and cancel invokes only the pending provider login',async()=>{
  const f=fixture();await f.flow.login();assert.equal(f.states.at(-1)!.status,'pending');assert.deepEqual(f.calls[1]!.params,{type:'chatgpt'});f.notify({loginId:'another',success:true});assert.equal(f.calls.length,2);f.notify({loginId:'fixture-login',success:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.states.at(-1)!.status,'signed-in');assert.equal(f.calls.at(-1)!.method,'account/read');await f.flow.login();await f.flow.cancel();assert.equal(f.calls.at(-1)!.method,'account/login/cancel');assert.deepEqual(f.calls.at(-1)!.params,{loginId:'fixture-login'});assert.equal(f.states.at(-1)!.status,'cancelled');f.notify({loginId:'fixture-login',success:true});assert.equal(f.states.at(-1)!.status,'cancelled');assert.ok(f.calls.every(call=>!/^thread|^turn/.test(call.method)));
});
test('failed login can retry; failed completion never reports signed in',async()=>{
  const f=fixture();f.fail();await assert.rejects(f.flow.login(),/fixture failure/);f.retry();await f.flow.login();f.notify({loginId:'fixture-login',success:false,error:'private error'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.states.at(-1)!.status,'error');assert.ok(!JSON.stringify(f.states).includes('private error'));await f.flow.login();await f.flow.cancel();
});
test('public account and browser destination validation fails closed',()=>{
  assert.equal(publicCodexAccount({account:null,requiresOpenaiAuth:true}).status,'signed-out');assert.equal(publicCodexAccount({account:{type:'apiKey'},requiresOpenaiAuth:true}).status,'other');assert.throws(()=>publicCodexAccount({account:{type:'unknown'},requiresOpenaiAuth:true}));assert.throws(()=>loginUrl('https://auth.openai.com.attacker.invalid/login'));assert.throws(()=>loginUrl('file:///C:/temp'));assert.throws(()=>loginUrl('https://user:secret@auth.openai.com/'));assert.equal(loginUrl('https://chatgpt.com/auth/login'),'https://chatgpt.com/auth/login');
});
test('cancellation during initialize cannot launch login or open browser',async()=>{
  let resolve!:(value:unknown)=>void;const methods:string[]=[],states:AccountState[]=[];let opened=false;
  const rpc:AccountRpc={request(method){methods.push(method);return new Promise(done=>resolve=done);},async close(){resolve({});}};
  const flow=new CodexAccountFlow(()=>rpc,state=>states.push(state),async()=>{opened=true;return true;});
  const pending=flow.login();await flow.cancel();await pending;assert.deepEqual(methods,['initialize']);assert.equal(opened,false);assert.equal(states.at(-1)!.status,'cancelled');
});
test('real JSONL account transport sends initialization and public read only',async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'hydra-account-fixture-'));
  try{
    await writeFile(path.join(cwd,'app-server'),`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);fs.appendFileSync('methods.jsonl',JSON.stringify(message)+'\\n');if(message.id)process.stdout.write(JSON.stringify({id:message.id,result:message.method==='account/read'?${JSON.stringify(account)}:{}})+'\\n');});`);
    const flow=new CodexAccountFlow((notify,failed)=>accountRpc(process.execPath,cwd,notify,failed),()=>{},async()=>{throw new Error('Unexpected browser');});await flow.refresh();
    const messages=(await readFile(path.join(cwd,'methods.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(messages.map(item=>item.method),['initialize','initialized','account/read']);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
