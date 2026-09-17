import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { SettingsImport } from './extensionImport';
import { AppearanceSettings } from './extensionSettings';
import { advanceOnboarding, onboardingSteps, readOnboarding, shouldOpenOnboarding, type OnboardingState } from './core/onboarding';
import type { ImportCategory } from './core/profileImport';

const stateKey = 'hydra.onboarding.v1';
export class Onboarding implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state: OnboardingState;
  private busy = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly imports: SettingsImport, private readonly appearance: AppearanceSettings) {
    this.state = readOnboarding(context.globalState.get(stateKey));
  }
  async autoShow(handoff: boolean): Promise<void> {
    if (!this.imports.available) return;
    // The bundled module remains Production even in a separate test harness.
    // Ask the owned workbench about the host, not only this extension's mode.
    const host = await Promise.resolve(vscode.commands.executeCommand<{ development: boolean }>('hydra.desktop.startupContext')).catch(() => undefined);
    if (shouldOpenOnboarding({ desktop: this.imports.available, trusted: vscode.workspace.isTrusted,
      development: host?.development !== false || this.context.extensionMode !== vscode.ExtensionMode.Production, handoff, completed: this.state.completed })) await this.show();
  }
  snapshot(): OnboardingState { return structuredClone(this.state); }
  async show(): Promise<void> {
    if (!this.imports.available) throw new Error('Onboarding is available in the local Hydra desktop IDE.');
    if (this.panel) { this.panel.reveal(); return; }
    if (this.state.completed) await this.save({ ...this.state, completed: false, step: this.state.step === 'project' ? 'welcome' : this.state.step });
    const panel = vscode.window.createWebviewPanel('hydra.onboarding', 'Welcome to Hydra', vscode.ViewColumn.Active, { enableScripts: true });
    this.panel = panel; panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
    panel.webview.html = this.html();
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(message => { void this.handle(message, panel); });
  }
  private async publish(panel: vscode.WebviewPanel, text = ''): Promise<void> {
    const undo = await this.imports.status();
    await panel.webview.postMessage({ type: 'state', state: this.state, undo, text });
  }
  private async save(state: OnboardingState): Promise<void> {
    await this.context.globalState.update(stateKey, state); this.state = state;
  }
  private async handle(value: unknown, panel: vscode.WebviewPanel): Promise<void> {
    if (this.busy) { await panel.webview.postMessage({ type: 'error', text: 'Wait for the current setup action to finish.' }); return; }
    this.busy = true;
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid onboarding action.');
      const message = value as Record<string, unknown>;
      if (message.type === 'ready') { await this.publish(panel); return; }
      if (message.type === 'later') { await this.save({ ...this.state, completed: true }); panel.dispose(); return; }
      if (message.type === 'next' || message.type === 'skip') {
        await this.save(advanceOnboarding(this.state, message.type === 'skip'));
        if (this.state.completed && this.state.step === 'project') { panel.dispose(); return; }
        await this.publish(panel); return;
      }
      if (message.type === 'back') {
        const index = onboardingSteps.indexOf(this.state.step);
        await this.save({ ...this.state, completed: false, step: onboardingSteps[Math.max(index - 1, 0)]! });
        await this.publish(panel); return;
      }
      if (message.type === 'import') {
        if (this.state.step !== 'import' || !['vscode', 'cursor', 'folder'].includes(String(message.provider))) throw new Error('Choose an import source on the import step.');
        const preview = await this.imports.choose(message.provider as 'vscode' | 'cursor' | 'folder');
        await panel.webview.postMessage({ type: 'preview', preview }); return;
      }
      if (message.type === 'apply') {
        if (this.state.step !== 'import' || typeof message.token !== 'string' || !Array.isArray(message.categories)) throw new Error('Preview preferences before importing.');
        const count = await this.imports.apply(message.token, message.categories as ImportCategory[]);
        await this.publish(panel, `Imported ${count} preference file${count === 1 ? '' : 's'}. Existing preferences were preserved.`); return;
      }
      if (message.type === 'undo') { await this.imports.undo(); await this.publish(panel, 'Restored your previous preferences.'); return; }
      if (message.type === 'appearance') {
        if (this.state.step !== 'appearance' || !['dark', 'light'].includes(String(message.mode))) throw new Error('Choose Dark or Light on the appearance step.');
        await this.appearance.setAppearance(message.mode as 'dark' | 'light'); await this.publish(panel, `Applied Hydra ${message.mode}.`); return;
      }
      if (message.type === 'providerGuide') {
        if (message.provider !== 'claude' && message.provider !== 'codex') throw new Error('Unknown provider.');
        await vscode.env.openExternal(vscode.Uri.parse(message.provider === 'claude' ? 'https://code.claude.com/docs/en/quickstart' : 'https://developers.openai.com/codex/quickstart'));
        await this.publish(panel, 'Opened the official setup guide. No account connection has been verified.'); return;
      }
      if (message.type === 'project') {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open project' });
        if (!picked?.[0]) { await this.publish(panel, 'Folder selection cancelled.'); return; }
        await this.save({ ...this.state, completed: true });
        await vscode.commands.executeCommand('vscode.openFolder', picked[0]); return;
      }
      throw new Error('Unknown onboarding action.');
    } catch (error) {
      await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Setup could not finish. Try again.' });
      await panel.webview.postMessage({ type: 'undoStatus', undo: await this.imports.status().catch(() => ({ available: false, interrupted: false })) });
    } finally { this.busy = false; }
  }
  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Welcome to Hydra</title><style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family)}main{max-width:900px;margin:0 auto;padding:44px 32px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:24px}.brand{font-size:18px;letter-spacing:.12em;font-weight:650}.layout{display:grid;grid-template-columns:150px 1fr;gap:48px;margin-top:42px}ol{list-style:none;margin:0;padding:0}nav li{padding:12px 0;color:var(--vscode-descriptionForeground);font-size:12px}nav li[aria-current=step]{color:var(--vscode-foreground);font-weight:650}nav span{font-variant-numeric:tabular-nums;margin-right:12px;color:var(--vscode-descriptionForeground)}h1{font-size:32px;line-height:1.15;font-weight:550;letter-spacing:-.035em;margin:0 0 20px}h2{font-size:16px;font-weight:550}p{line-height:1.7;color:var(--vscode-descriptionForeground);max-width:500px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.13em;margin:0 0 16px;color:var(--vscode-foreground)}button{font:inherit;cursor:pointer;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:4px;padding:10px 15px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.quiet{background:transparent}.card{border:1px solid var(--vscode-panel-border);padding:20px;margin:14px 0}.card p{margin-bottom:0}.themes{display:flex;gap:16px;margin:24px 0}.theme{flex:1;text-align:left;padding:10px}.sample{height:90px;display:block;border:1px solid var(--vscode-panel-border);padding:16px;margin-bottom:12px}.sample::after{content:'';display:block;background:#173c2c;width:45%;height:5px;margin-top:14px}.dark{background:#141414;color:#eee}.light{background:#fafbf9;color:#18221c}footer{border-top:1px solid var(--vscode-panel-border);margin-top:34px;padding-top:22px;display:flex;gap:10px}footer .primary{margin-left:auto}#status{min-height:24px;white-space:pre-wrap}#preview{border:1px solid var(--vscode-panel-border);padding:18px;margin-top:20px}#items{max-height:220px;overflow:auto;line-height:1.8;padding-left:20px}#warnings{line-height:1.7;padding-left:20px}.categories{display:flex;gap:15px;flex-wrap:wrap;margin:18px 0}input{accent-color:var(--vscode-focusBorder)}[hidden]{display:none!important}@media(max-width:620px){main{padding:24px 18px}.layout{display:block;margin-top:24px}nav ol{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}nav li{padding:0}nav span{display:none}h1{font-size:28px}}@media(forced-colors:active){.sample{forced-color-adjust:auto}}
    </style></head><body><main><header><span class="brand">HYDRA</span><button class="quiet" data-action="later">Set up later</button></header><div class="layout"><nav aria-label="Setup progress"><ol>${onboardingSteps.map((step, index) => `<li data-step="${step}"><span>0${index + 1}</span>${({ welcome: 'Welcome', import: 'Preferences', appearance: 'Appearance', accounts: 'Providers', project: 'Your project' })[step]}</li>`).join('')}</ol></nav><div>
    <section data-page="welcome"><p class="eyebrow">Your editor. Your workflow.</p><h1>A place to build<br>with your agents.</h1><p>Bring the parts of your editor you already like. Choose an appearance, then open a project and start working.</p><div class="card"><h2>A few choices. All optional.</h2><p>Closing this tab saves your place. You can return anytime from Hydra Settings.</p></div></section>
    <section data-page="import" hidden><p class="eyebrow">01 / Preferences</p><h1>Make yourself at home.</h1><p>Preview settings, keybindings, and snippets from your existing editor. Your current Hydra preferences win on conflicts.</p><div class="actions"><button data-source="vscode">From VS Code</button><button data-source="cursor">From Cursor</button><button data-source="folder">Choose profile folder…</button></div><div id="preview" tabindex="-1" hidden><h2>Review your import</h2><p id="source"></p><div class="categories">${['settings','keybindings','snippets'].map(category => `<label><input type="checkbox" data-category="${category}"> ${category} <span data-count="${category}"></span></label>`).join('')}</div><ul id="items" tabindex="0" aria-label="Preference changes"></ul><p id="truncated" hidden>Showing the first 500 entries. Totals include all entries.</p><ul id="warnings"></ul><button class="primary" id="apply">Import selected preferences</button></div><p id="recovery" hidden>An earlier import was interrupted. Undo it before importing again. Your backup is retained if newer edits prevent recovery.</p><div class="actions"><button id="undo" disabled>Undo last import</button></div><p>Accounts, histories, extensions, and task configuration are not imported.</p></section>
    <section data-page="appearance" hidden><p class="eyebrow">02 / Appearance</p><h1>Choose your perspective.</h1><p>One theme for your editor, terminals, and agents. Continuing without a choice keeps your current or imported appearance.</p><div class="themes"><button class="theme" data-mode="dark"><span class="sample dark" aria-hidden="true">Hydra</span>Dark</button><button class="theme" data-mode="light"><span class="sample light" aria-hidden="true">Hydra</span>Light</button></div><p>These choices disable automatic system theme switching. High-contrast themes remain available in editor settings.</p></section>
    <section data-page="accounts" hidden><p class="eyebrow">03 / Providers</p><h1>Your tools. Your accounts.</h1><p>Hydra runs the official provider tools. Install and sign in through their own setup flows; their account credentials stay with them.</p><div class="card"><h2>Claude Code</h2><p>Use the unmodified Claude Code CLI and its official sign-in flow.</p><div class="actions"><button data-provider="claude">Claude Code setup guide ↗</button></div></div><div class="card"><h2>OpenAI Codex</h2><p>Use Codex with your ChatGPT account through its official sign-in flow.</p><div class="actions"><button data-provider="codex">Codex setup guide ↗</button></div></div><p>Integrated account connection and verified account status are not available in this setup yet. Opening a guide does not connect an account or run a model.</p></section>
    <section data-page="project" hidden><p class="eyebrow">04 / Your project</p><h1>Ready when you are.</h1><p>Open a folder to start editing. Your setup choices are saved, and you can revisit every step from Settings.</p><div class="actions"><button class="primary" data-action="project">Open a project folder…</button></div><p>Opening a project does not start an agent task.</p></section>
    <p id="status" role="status" aria-live="polite"></p><footer><button data-action="back" id="back">Back</button><button class="quiet" data-action="skip" id="skip">Skip this step</button><button class="primary" data-action="next" id="next">Get started</button></footer></div></div></main><script nonce="${nonce}">
    const api=acquireVsCodeApi();let state,preview,busy=false,undoAvailable=false;const status=document.getElementById('status');
    function update(){document.querySelectorAll('button').forEach(button=>button.disabled=busy);document.getElementById('back').disabled=busy||state?.step==='welcome';document.getElementById('undo').disabled=busy||!undoAvailable;document.getElementById('apply').disabled=busy||!preview||![...document.querySelectorAll('[data-category]')].some(input=>input.checked&&preview.counts[input.dataset.category]>0);}
    function send(message){busy=true;status.textContent='Working…';update();api.postMessage(message);}
    document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>send({type:button.dataset.action})));
    document.querySelectorAll('[data-source]').forEach(button=>button.addEventListener('click',()=>{preview=undefined;document.getElementById('preview').hidden=true;send({type:'import',provider:button.dataset.source});}));
    document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>send({type:'appearance',mode:button.dataset.mode})));
    document.querySelectorAll('[data-provider]').forEach(button=>button.addEventListener('click',()=>send({type:'providerGuide',provider:button.dataset.provider})));
    document.querySelectorAll('[data-category]').forEach(input=>input.addEventListener('change',update));document.getElementById('apply').addEventListener('click',()=>send({type:'apply',token:preview.token,categories:[...document.querySelectorAll('[data-category]')].filter(input=>input.checked).map(input=>input.dataset.category)}));document.getElementById('undo').addEventListener('click',()=>send({type:'undo'}));
    function undo(value){undoAvailable=value.available;document.getElementById('recovery').hidden=!value.interrupted;}
    window.addEventListener('message',event=>{const m=event.data;if(m.type==='state'){const changed=state?.step!==m.state.step;state=m.state;busy=false;preview=undefined;document.getElementById('preview').hidden=true;undo(m.undo);document.querySelectorAll('[data-page]').forEach(page=>page.hidden=page.dataset.page!==state.step);document.querySelectorAll('[data-step]').forEach(row=>{if(row.dataset.step===state.step)row.setAttribute('aria-current','step');else row.removeAttribute('aria-current');});document.getElementById('next').textContent=state.step==='project'?'Start editing':state.step==='welcome'?'Get started':'Continue';document.getElementById('skip').hidden=state.step==='welcome'||state.step==='project';status.textContent=m.text;if(changed){const heading=document.querySelector('[data-page="'+state.step+'"] h1');heading.tabIndex=-1;heading.focus();}}
    if(m.type==='preview'){busy=false;preview=m.preview;status.textContent=preview?'Review the changes before importing.':'Folder selection cancelled.';if(preview){const box=document.getElementById('preview');box.hidden=false;document.getElementById('source').textContent='From '+preview.source+' into '+preview.profile;document.querySelectorAll('[data-category]').forEach(input=>{input.checked=preview.counts[input.dataset.category]>0;document.querySelector('[data-count="'+input.dataset.category+'"]').textContent='('+preview.counts[input.dataset.category]+' new)';});for(const [id,values]of [['items',preview.items.map(item=>(item.state==='add'?'Add':item.state==='conflict'?'Keep':'Skip')+' · '+item.name+(item.detail?' — '+item.detail:''))],['warnings',preview.warnings]]){const list=document.getElementById(id);list.replaceChildren();for(const text of values){const row=document.createElement('li');row.textContent=text;list.appendChild(row);}}document.getElementById('truncated').hidden=!preview.truncated;box.focus();}}
    if(m.type==='error'){busy=false;status.textContent=m.text;}if(m.type==='undoStatus')undo(m.undo);update();});api.postMessage({type:'ready'});
    </script></body></html>`;
  }
  dispose(): void { this.panel?.dispose(); }
}
