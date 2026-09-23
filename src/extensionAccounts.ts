import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { accountRpc, CodexAccountFlow, accountVersions as versions, supportedAccountVersion, publicClaudeAccount, type AccountState } from './core/accountSetup';
import { findProvider } from './core/providers';
import { processLaunch, runProbe } from './core/process';
import type { Provider } from './core/model';

export class ProviderAccounts implements vscode.Disposable {
  private panel?:vscode.WebviewPanel;
  private readonly states:Record<Provider,AccountState>={claude:{status:'unchecked',text:'Not checked. Sign in or refresh when ready.'},codex:{status:'unchecked',text:'Not checked. Sign in or refresh when ready.'}};
  private readonly probes=new Map<Provider,AbortController>();
  private codex?:CodexAccountFlow;
  private terminal?:vscode.Terminal;
  private disposed=false;
  private readonly closed:vscode.Disposable;
  constructor(private readonly context:vscode.ExtensionContext,private readonly available:boolean){
    this.closed=vscode.window.onDidCloseTerminal(terminal=>{if(this.terminal===terminal){this.terminal=undefined;this.update('claude',{status:'unchecked',text:'Claude Code sign-in terminal closed. Refresh status to check the result.'});}});
  }
  snapshot():Record<Provider,AccountState>{return structuredClone(this.states);}
  private update(provider:Provider,state:AccountState):void{if(this.disposed)return;this.states[provider]=state;void this.panel?.webview.postMessage({type:'accounts',states:this.snapshot()});}
  show(focus?:Provider,autoLogin?:boolean):void{
    if(!this.available)throw new Error('Account setup is available in the local Hydra desktop IDE.');
    // Check the provider's own reported status first: an already signed-in
    // account needs no sign-in flow, so Claude's CLI terminal is never opened
    // for an account that is already connected.
    const startLogin=(provider:Provider)=>{void (async()=>{
      await this.action(provider,'refresh');
      if(this.states[provider].status==='signed-in')return;
      await this.action(provider,'login');
    })().catch(()=>this.update(provider,{status:'error',text:'Use account setup in your trusted local Hydra window.'}));};
    if(this.panel){
      this.panel.reveal();
      if(focus==='claude'||focus==='codex'){
        void this.panel.webview.postMessage({type:'focus',provider:focus});
        if(autoLogin)startLogin(focus);
      }
      return;
    }
    const panel=vscode.window.createWebviewPanel('hydra.accounts','Hydra · Accounts',vscode.ViewColumn.Active,{enableScripts:true});this.panel=panel;
    panel.webview.html=this.html();panel.onDidDispose(()=>{if(this.panel===panel)this.panel=undefined;});
    panel.webview.onDidReceiveMessage((value:unknown)=>{
      if(!value||typeof value!=='object')return;const message=value as Record<string,unknown>;
      if(message.type==='ready'){
        void panel.webview.postMessage({type:'accounts',states:this.snapshot()});
        if(focus==='claude'||focus==='codex'){
          void panel.webview.postMessage({type:'focus',provider:focus});
          if(autoLogin)startLogin(focus);
        }
        return;
      }
      if((message.provider==='claude'||message.provider==='codex')&&['login','refresh','cancel','guide'].includes(String(message.type))){const provider=message.provider;void this.action(provider,message.type as 'login'|'refresh'|'cancel'|'guide').catch(()=>this.update(provider,{status:'error',text:'Use account setup in your trusted local Hydra window.'}));}
    });
  }
  async action(provider:Provider,action:'login'|'refresh'|'cancel'|'guide'):Promise<void>{
    if(action==='cancel'){
      this.probes.get(provider)?.abort();this.probes.delete(provider);
      if(provider==='codex'){const flow=this.codex;this.codex=undefined;await flow?.cancel().catch(()=>{});}
      else{const terminal=this.terminal;this.terminal=undefined;terminal?.dispose();}
      this.update(provider,{status:'cancelled',text:'Local setup stopped. This does not sign out an existing account. Refresh to check.'});return;
    }
    if(!this.available||!vscode.workspace.isTrusted||this.disposed||vscode.env.remoteName||vscode.workspace.getConfiguration('hydra').get('handoff'))throw new Error('Use account setup in your trusted local Hydra window.');
    if(action==='guide'){await vscode.env.openExternal(vscode.Uri.parse(provider==='claude'?'https://code.claude.com/docs/en/setup':'https://developers.openai.com/codex/cli'));return;}
    if(this.probes.has(provider)||this.states[provider].status==='pending'||this.states[provider].status==='working')return;
    const controller=new AbortController();this.probes.set(provider,controller);this.update(provider,{status:'working',text:'Checking the installed provider version…'});
    try{
      const configured=vscode.workspace.getConfiguration('hydra').get<string>(`${provider}Path`);
      const found=await findProvider(provider,configured);if(controller.signal.aborted)return;
      if(!found.executable)throw new Error(`Install ${provider==='claude'?'Claude Code':'Codex'} ${versions[provider]} using its official guide, or set its executable path in Hydra editor settings.`);
      const cwd=this.context.globalStorageUri.fsPath;await mkdir(cwd,{recursive:true});
      const version=await runProbe(found.executable,['--version'],cwd,{signal:controller.signal,timeoutMs:8000,maxBytes:16384});
      if(controller.signal.aborted)return;
      if(version.error||version.exitCode!==0||!supportedAccountVersion(provider,version.stdout))throw new Error(`Account setup requires the tested ${provider} ${versions[provider]} CLI. Use its official guide to install that version or manage sign-in in the official client.`);
      if(provider==='codex'){
        const flow=new CodexAccountFlow((notify,failed)=>accountRpc(found.executable!,cwd,notify,failed),state=>{if(this.codex===flow)this.update(provider,state);},async url=>{if(controller.signal.aborted||this.disposed)return false;return vscode.env.openExternal(vscode.Uri.parse(url));});this.codex=flow;
        if(action==='login')await flow.login();else await flow.refresh();
      }else if(action==='login'){
        const launch=processLaunch(found.executable,['auth','login','--claudeai']);
        this.terminal=vscode.window.createTerminal({name:'Claude Code · Subscription sign-in',cwd,shellPath:launch.executable,shellArgs:launch.args,isTransient:true});this.terminal.show(false);
        this.update(provider,{status:'pending',text:'Complete the unmodified Claude Code sign-in flow in its terminal/browser. Close that terminal, then refresh status. Hydra does not read its terminal output.'});
      }else{
        const status=await runProbe(found.executable,['auth','status','--json'],cwd,{signal:controller.signal,timeoutMs:15000,maxBytes:16384});
        if(controller.signal.aborted)return;
        // Only public auth-mode fields are interpreted; identity and credential fields are discarded.
        this.update(provider,publicClaudeAccount(status.exitCode,status.error,status.stdout));
      }
    }catch(error){if(!controller.signal.aborted)this.update(provider,{status:'error',text:error instanceof Error?error.message:'Account setup failed. Retry or use the official client.'});}
    finally{if(this.probes.get(provider)===controller)this.probes.delete(provider);}
  }
  async shutdown():Promise<void>{this.disposed=true;for(const controller of this.probes.values())controller.abort();this.probes.clear();this.terminal?.dispose();this.terminal=undefined;await this.codex?.cancel().catch(()=>{});}
  dispose():void{this.closed.dispose();this.panel?.dispose();void this.shutdown();}
  private html():string{
    const nonce=randomBytes(24).toString('base64');
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'nonce-${nonce}';script-src 'nonce-${nonce}'"><style nonce="${nonce}">
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}main{max-width:700px;margin:0 auto;padding:44px 30px}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:24px;font-size:12px;letter-spacing:.13em}h1{font-size:32px;font-weight:550;letter-spacing:-.035em;margin-top:34px}p{line-height:1.7;color:var(--vscode-descriptionForeground)}article{border-top:1px solid var(--vscode-panel-border);padding:24px 0}h2{font-size:18px;font-weight:550;margin:0}button{font:inherit;cursor:pointer;padding:9px 13px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.actions{display:flex;flex-wrap:wrap;gap:10px}.status{min-height:44px;white-space:pre-wrap}[hidden]{display:none!important}button{background:#ececec;color:#3a3a3a;border-color:#e0e0e0}button:hover{background:#e0e0e0}button.primary{background:#e4e4e4;color:#2a2a2a;font-weight:600}</style></head><body><main><header>HYDRA / ACCOUNTS</header><h1>Your providers. Their sign-in.</h1><p>Sign in with your subscription through the official installed tools. Credentials stay with the provider. Opening this page does not contact an account or start a model.</p>
    ${(['claude','codex'] as const).map(provider=>`<article data-provider="${provider}"><h2>${provider==='claude'?'Claude Code':'OpenAI Codex'}</h2><p>${provider==='claude'?'Claude Code 2.1.270 · Opens the official CLI sign-in terminal':'Codex 0.154.0 · Opens its ChatGPT sign-in page'}</p><p class="status" role="status"></p><div class="actions"><button class="primary" data-action="login">${provider==='claude'?'Sign in to Claude Code':'Sign in with ChatGPT'}</button><button data-action="refresh">Refresh status</button><button data-action="cancel" hidden>Cancel setup</button><button data-action="guide">Install / setup guide ↗</button></div></article>`).join('')}
    <p>Cancel stops Hydra’s local setup attempt; it does not revoke a completed sign-in. Manage account sign-out in the official provider client. A reported sign-in does not guarantee subscription eligibility or model access.</p></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('article').forEach(card=>card.querySelectorAll('button').forEach(button=>button.onclick=()=>vscode.postMessage({type:button.dataset.action,provider:card.dataset.provider})));window.addEventListener('message',event=>{if(event.data.type==='focus'){const card=document.querySelector('[data-provider="'+event.data.provider+'"]');const button=card&&card.querySelector('[data-action=login]');if(button){card.scrollIntoView({block:'center'});button.focus();}return;}if(event.data.type!=='accounts')return;for(const [provider,state]of Object.entries(event.data.states)){const card=document.querySelector('[data-provider="'+provider+'"]');if(!card)continue;card.querySelector('.status').textContent=state.text;const active=['working','pending'].includes(state.status);card.querySelector('[data-action=login]').disabled=active;card.querySelector('[data-action=refresh]').disabled=active;card.querySelector('[data-action=cancel]').hidden=!active;}});vscode.postMessage({type:'ready'});</script></body></html>`;
  }
}
