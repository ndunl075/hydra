import { spawn } from 'node:child_process';
import { CodexMessages, record } from './codexProtocol';
import { processLaunch, terminateProcessTree } from './process';
import type { GetAccountParams } from './generated/codex-0.154.0/v2/GetAccountParams';
import type { LoginAccountParams } from './generated/codex-0.154.0/v2/LoginAccountParams';
import type { CancelLoginAccountParams } from './generated/codex-0.154.0/v2/CancelLoginAccountParams';

export type AccountState = { status: 'unchecked'|'working'|'pending'|'signed-in'|'signed-out'|'other'|'cancelled'|'error'; text: string };
export const accountVersions = { claude:'2.1.270',codex:'0.154.0' };
export function supportedAccountVersion(provider:keyof typeof accountVersions,output:string):boolean {
  return new RegExp(`(?:^|\\s)${accountVersions[provider].replaceAll('.','\\.')}(?:\\s|$)`).test(output);
}
export function publicClaudeAccount(exitCode:number|null,error?:string,output=''):AccountState {
  if(error||![0,1].includes(exitCode!))throw new Error('Claude Code could not report account status. Retry or use its official client.');
  let value:Record<string,unknown>|undefined;
  try { const parsed:unknown=JSON.parse(output);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=parsed as Record<string,unknown>; } catch { /* Older/unsupported public schema: report only the documented exit status. */ }
  if(value&&typeof value.loggedIn==='boolean'&&typeof value.authMethod==='string'&&typeof value.apiProvider==='string'){
    if(value.loggedIn!==(exitCode===0))throw new Error('Claude Code returned inconsistent account status. Refresh or use its official client.');
    if(!value.loggedIn)return {status:'signed-out',text:'Claude Code reports not signed in.'};
    if(value.authMethod==='claude.ai'&&value.apiProvider==='firstParty')return {status:'signed-in',text:'Claude Code reports a signed-in Claude.ai account. Subscription entitlement and model access have not been tested.'};
    return {status:'other',text:'Claude Code reports another authentication mode. A Claude.ai subscription sign-in has not been verified.'};
  }
  return exitCode===0?{status:'signed-in',text:'Claude Code reports signed in. Account type, subscription entitlement, and model access have not been tested.'}:{status:'signed-out',text:'Claude Code reports not signed in.'};
}
export interface AccountRpc {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}
/** Separate account-only channel. Never logs protocol payloads or requests a model turn. */
export function accountRpc(executable: string, cwd: string, notify: (method: string, params: unknown) => void, failed: () => void): AccountRpc {
  const launch = processLaunch(executable, ['app-server', '--listen', 'stdio://']);
  const child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
  let next = 0, closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const clear = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('Codex account connection closed.')); } pending.clear(); };
  const stop = async () => { if (closed) return; closed = true; clear(); child.stdin.end(); if (child.pid && child.exitCode === null && child.signalCode === null) await terminateProcessTree(child.pid); };
  const fail = () => { if (closed) return; failed(); void stop().catch(() => {}); };
  const send = (value: unknown) => { if (closed) throw new Error('Codex account connection closed.'); child.stdin.write(JSON.stringify(value)+'\n'); };
  const messages = new CodexMessages(message => {
    if (typeof message.method === 'string') {
      if ('id' in message) { send({ id: message.id, error: { code: -32601, message: 'Account setup does not support server requests.' } }); return; }
      if (message.method === 'account/login/completed') notify(message.method, message.params);
      return;
    }
    const entry = pending.get(message.id); if (!entry) throw new Error('Unexpected account response.');
    clearTimeout(entry.timer); pending.delete(message.id);
    if ('error' in message) entry.reject(new Error('Codex rejected the account request. Use its official client or retry.'));
    else entry.resolve(message.result);
  });
  child.stdout.on('data', data => { try { messages.push(data); } catch { fail(); } });
  // Provider diagnostics can contain private data. Drain without retaining or publishing.
  child.stderr.resume(); child.stdin.on('error', fail); child.on('error', fail); child.on('close', fail);
  return { close: stop, request(method, params) {
    if (!['initialize','account/read','account/login/start','account/login/cancel'].includes(method)) return Promise.reject(new Error('Unsupported account method.'));
    return new Promise((resolve,reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex account request timed out.')); }, 15000);
      pending.set(id,{ resolve: value => { if (method === 'initialize') send({method:'initialized'}); resolve(value); },reject,timer });
      try { send({ id,method,params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  } };
}
export function publicCodexAccount(value: unknown): AccountState {
  const result = record(value);
  if (typeof result.requiresOpenaiAuth !== 'boolean') throw new Error('Unsupported Codex account response.');
  if (result.account === null) return { status:'signed-out', text:'Codex reports no signed-in account.' };
  const account = record(result.account);
  if (account.type === 'chatgpt' && (account.email === null || typeof account.email === 'string') && typeof account.planType === 'string') return { status:'signed-in', text:'Codex reports a signed-in ChatGPT account. Model access has not been tested.' };
  if (account.type === 'apiKey' || account.type === 'amazonBedrock') return { status:'other', text:'Codex uses another authentication method. This is not a verified ChatGPT subscription sign-in.' };
  throw new Error('Unsupported Codex account response.');
}
export function loginUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid provider login URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com','chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Unexpected provider login destination.');
  return url.href;
}
export class CodexAccountFlow {
  private rpc?: AccountRpc;
  private loginId?: string;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private early: unknown[] = [];
  constructor(private readonly connect: (notify:(method:string,params:unknown)=>void,failed:()=>void)=>AccountRpc, private readonly changed:(state:AccountState)=>void, private readonly open:(url:string)=>Promise<boolean>) {}
  private async start(): Promise<{rpc:AccountRpc;epoch:number}> {
    if (this.rpc) throw new Error('Finish or cancel the current Codex account action first.');
    const epoch = ++this.epoch;
    const rpc = this.connect((_method,params)=>{ if (epoch !== this.epoch) return; if (!this.loginId) this.early.push(params); else void this.completed(params,epoch); },()=>{ if(epoch===this.epoch){this.changed({status:'error',text:'Codex account process ended. Refresh or retry sign-in.'}); void this.close();} });
    this.rpc=rpc; this.changed({status:'working',text:'Contacting the installed Codex CLI…'});
    try { await rpc.request('initialize',{clientInfo:{name:'hydra_account_setup',title:'Hydra account setup',version:'1'},capabilities:null}); return {rpc,epoch}; }
    catch(error) { if(epoch===this.epoch)await this.close(); throw error; }
  }
  async refresh(): Promise<void> {
    const {rpc,epoch}=await this.start();
    if(epoch!==this.epoch)return;
    try { const state=publicCodexAccount(await rpc.request('account/read',{refreshToken:false} satisfies GetAccountParams)); if(epoch===this.epoch)this.changed(state); }
    finally { if(epoch===this.epoch)await this.close(); }
  }
  async login(): Promise<void> {
    const {rpc,epoch}=await this.start();
    if(epoch!==this.epoch)return;
    try {
      const result=record(await rpc.request('account/login/start',{type:'chatgpt'} satisfies LoginAccountParams));
      if(epoch!==this.epoch)return;
      if(result.type!=='chatgpt'||typeof result.loginId!=='string'||!result.loginId.length)throw new Error('Unsupported Codex login response.');
      this.loginId=result.loginId;
      const url=loginUrl(result.authUrl);
      this.changed({status:'pending',text:'Finish signing in through Codex in your browser. You can cancel or retry here.'});
      this.timer=setTimeout(()=>{void this.cancel().then(()=>this.changed({status:'error',text:'Sign-in timed out. Retry when ready.'})).catch(()=>{});},300000);
      if(!await this.open(url))throw new Error('The browser did not open. Cancel and retry sign-in.');
      for(const item of this.early.splice(0))void this.completed(item,epoch);
    } catch(error) { if(epoch===this.epoch)await this.cancel(); throw error; }
  }
  private async completed(value:unknown,epoch:number):Promise<void>{
    try{
      const result=record(value);if(result.loginId!==this.loginId||epoch!==this.epoch)return;
      if(typeof result.success!=='boolean')throw new Error('Invalid login completion.');
      this.loginId=undefined;clearTimeout(this.timer);
      if(!result.success){this.changed({status:'error',text:'Codex sign-in did not complete. Retry or use the official client.'});await this.close();return;}
      const state=publicCodexAccount(await this.rpc!.request('account/read',{refreshToken:false} satisfies GetAccountParams));
      if(epoch===this.epoch){this.changed(state);await this.close();}
    }catch{if(epoch===this.epoch){this.changed({status:'error',text:'Could not verify Codex account status. Refresh to retry.'});await this.close();}}
  }
  async cancel():Promise<void>{
    const rpc=this.rpc,id=this.loginId;++this.epoch;this.loginId=undefined;clearTimeout(this.timer);
    try{if(rpc&&id)await rpc.request('account/login/cancel',{loginId:id} satisfies CancelLoginAccountParams);}
    finally{await this.close();this.changed({status:'cancelled',text:'Local sign-in stopped. Any completed provider sign-in remains owned by Codex; refresh to check.'});}
  }
  async close():Promise<void>{++this.epoch;clearTimeout(this.timer);this.loginId=undefined;this.early=[];const rpc=this.rpc;this.rpc=undefined;await rpc?.close();}
}
