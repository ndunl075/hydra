import * as vscode from 'vscode';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { accountRpc, supportedAccountVersion } from './core/accountSetup';
import { readCodexQuota, type QuotaState } from './core/quota';
import { findProvider } from './core/providers';
import { runProbe } from './core/process';
import type { Provider } from './core/model';

export class ProviderQuota implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state: QuotaState = { status: 'unchecked', text: 'Not checked. Refresh when ready.' };
  private controller?: AbortController;
  private pending?: Promise<void>;
  private disposed = false;
  private readonly configuration: vscode.Disposable;
  constructor(private readonly context: vscode.ExtensionContext, private readonly available: boolean) {
    this.configuration = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('hydra.codexPath') && !event.affectsConfiguration('hydra.handoff')) return;
      this.controller?.abort(); this.controller = undefined;
      this.update({ status: 'unchecked', text: 'Provider configuration changed. Refresh to read its usage limits.' });
    });
  }
  snapshot(): QuotaState { return structuredClone(this.state); }
  private update(state: QuotaState): void { if (this.disposed) return; this.state = state; void this.panel?.webview.postMessage({ type: 'quota', state: this.snapshot() }); }
  show(): void {
    if (!this.available) throw new Error('Usage limits are available in the local Hydra desktop IDE.');
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('hydra.quotas', 'Hydra · Usage limits', vscode.ViewColumn.Active, { enableScripts: true });
    this.panel = panel; panel.webview.html = this.html();
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage((value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const message = value as Record<string, unknown>;
      if (message.type === 'ready') { void panel.webview.postMessage({ type: 'quota', state: this.snapshot() }); return; }
      if (message.type === 'refresh') void this.refresh().catch(() => this.update({ status: 'error', text: 'Use usage limits in your trusted local Hydra window.', snapshot: this.state.snapshot }));
      if (message.type === 'cancel') void this.cancel();
      if (message.type === 'guide' && (message.provider === 'claude' || message.provider === 'codex')) void this.guide(message.provider);
    });
  }
  async guide(provider: Provider): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(provider === 'claude' ? 'https://code.claude.com/docs/en/costs#using-the-usage-command' : 'https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt'));
  }
  refresh(): Promise<void> {
    if (!this.available || !vscode.workspace.isTrusted || this.disposed || vscode.env.remoteName || vscode.workspace.getConfiguration('hydra').get('handoff')) return Promise.reject(new Error('Use usage limits in your trusted local Hydra window.'));
    if (this.pending) return this.pending;
    const controller = new AbortController(); this.controller = controller;
    const previous = this.state.snapshot;
    this.update({ status: 'checking', text: 'Checking the installed Codex CLI…', snapshot: previous });
    const action = async () => {
      try {
        const found = await findProvider('codex', vscode.workspace.getConfiguration('hydra').get<string>('codexPath'));
        if (controller.signal.aborted) return;
        if (!found.executable) throw new Error('Install official Codex 0.154.0 or set its executable path in Hydra settings.');
        const cwd = this.context.globalStorageUri.fsPath; await mkdir(cwd, { recursive: true });
        const version = await runProbe(found.executable, ['--version'], cwd, { signal: controller.signal, timeoutMs: 8000, maxBytes: 16384 });
        if (controller.signal.aborted) return;
        if (version.error || version.exitCode !== 0 || !supportedAccountVersion('codex', version.stdout)) throw new Error('Usage-limit refresh requires tested Codex 0.154.0. Use the official client for another version.');
        const snapshot = await readCodexQuota(() => accountRpc(found.executable!, cwd, () => {}, () => {}, 'quota'), controller.signal);
        if (!controller.signal.aborted && this.controller === controller) this.update({ status: 'checked', text: 'Provider-reported Codex usage limits. These are shared across the signed-in account.', snapshot });
      } catch {
        if (!controller.signal.aborted && this.controller === controller) this.update({ status: 'error', text: 'Codex could not report usage limits. Check its executable version and ChatGPT sign-in in the official client, then retry. No model turn was submitted.', snapshot: previous });
      }
    };
    this.pending = action().finally(() => { if (this.controller === controller) this.controller = undefined; this.pending = undefined; });
    return this.pending;
  }
  async cancel(): Promise<void> { this.controller?.abort(); this.controller = undefined; this.update({ status: 'cancelled', text: 'Local refresh stopped. No sign-in or account limits were changed.', snapshot: this.state.snapshot }); await this.pending; }
  async shutdown(): Promise<void> { this.disposed = true; this.controller?.abort(); await this.pending; }
  dispose(): void { this.configuration.dispose(); this.panel?.dispose(); void this.shutdown(); }
  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}main{max-width:760px;margin:0 auto;padding:44px 30px}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:24px;font-size:12px;letter-spacing:.13em}h1{font-size:32px;font-weight:550;letter-spacing:-.035em;margin-top:34px}p{line-height:1.7;color:var(--vscode-descriptionForeground)}article{border-top:1px solid var(--vscode-panel-border);padding:24px 0}h2{font-size:18px;font-weight:550}button{font:inherit;cursor:pointer;padding:9px 13px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.actions{display:flex;flex-wrap:wrap;gap:10px}.bucket{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:16px;margin:14px 0}.bucket p{margin:8px 0}#quota-status{min-height:40px}[hidden]{display:none!important}</style></head><body><main><header>HYDRA / USAGE LIMITS</header><h1>Reported by your provider.</h1><p>Account limits are separate from Hydra's task/project token totals and soft budgets. Opening this page is passive. Refresh reads through the official installed Codex CLI without submitting a model turn.</p><article><h2>Codex / ChatGPT</h2><p id="quota-status" role="status"></p><div class="actions"><button id="refresh">Refresh Codex limits</button><button id="cancel" hidden>Cancel refresh</button><button data-guide="codex">Official limit guidance ↗</button></div><p id="observation"></p><p id="permission"></p><div id="buckets"></div><p>Percentages describe the observed quota windows; they do not guarantee model access or permission to start new work. Reset times are shown in your device's local time zone. Missing windows and fields stay unavailable. Hydra does not purchase credits, consume resets or change billing.</p></article><article><h2>Claude Code</h2><p>Limits unavailable in Hydra: no verified read-only subscription-limit contract is implemented. Use <code>/usage</code> in the official interactive Claude Code client to inspect plan usage. Hydra's recorded API estimates are not subscription bills or remaining allowance.</p><button data-guide="claude">Official /usage guidance ↗</button></article></main><script nonce="${nonce}">
const api=acquireVsCodeApi();document.querySelector('#refresh').onclick=()=>api.postMessage({type:'refresh'});document.querySelector('#cancel').onclick=()=>api.postMessage({type:'cancel'});document.querySelectorAll('[data-guide]').forEach(button=>button.onclick=()=>api.postMessage({type:'guide',provider:button.dataset.guide}));
const paragraph=(parent,text)=>{const p=document.createElement('p');p.textContent=text;parent.append(p);};window.addEventListener('message',event=>{if(event.data.type!=='quota')return;const state=event.data.state,snapshot=state.snapshot;document.querySelector('#quota-status').textContent=state.text;document.querySelector('#refresh').disabled=state.status==='checking';document.querySelector('#cancel').hidden=state.status!=='checking';document.querySelector('#observation').textContent=snapshot?'Fetched '+new Date(snapshot.fetchedAt).toLocaleString()+(state.status==='checked'?'. Refresh to update.':'. Last observation may be stale; current limits are unavailable.'):'No quota observation yet.';document.querySelector('#permission').textContent=snapshot?.ordinaryUsageAllowed===true?'Provider reported ordinary included usage allowed.':snapshot?.ordinaryUsageAllowed===false?'Provider reported ordinary included usage held.':'Provider permission to use ordinary included usage: unavailable.';const list=document.querySelector('#buckets');list.replaceChildren();if(!snapshot?.buckets.length)paragraph(list,'Quota windows unavailable.');for(const bucket of snapshot?.buckets||[]){const card=document.createElement('section');card.className='bucket';const heading=document.createElement('h3');heading.textContent=bucket.name||bucket.id||'Provider bucket';card.append(heading);for(const key of ['primary','secondary']){const window=bucket[key],name=key==='primary'?'Primary':'Secondary';if(!window){paragraph(card,name+' window: unavailable');continue;}paragraph(card,name+' window: '+window.remainingPercent.toLocaleString()+'% remaining · '+window.usedPercent.toLocaleString()+'% used');paragraph(card,'Duration: '+(window.windowDurationMins===undefined?'Unavailable':window.windowDurationMins.toLocaleString()+' minutes'));paragraph(card,'Reset: '+(window.resetsAt===undefined?'Unavailable':new Date(window.resetsAt*1000).toLocaleString()+' ('+Intl.DateTimeFormat().resolvedOptions().timeZone+')'));}list.append(card);}});api.postMessage({type:'ready'});</script></body></html>`;
  }
}
