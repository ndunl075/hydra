import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { SettingsImport } from './extensionImport';
import { AppearanceSettings } from './extensionSettings';
import { advanceOnboarding, onboardingSteps, readOnboarding, shouldOpenOnboarding, type OnboardingState } from './core/onboarding';
import type { ImportCategory } from './core/profileImport';
import { connectionsScript, connectionsSection, handleConnectionsMessage } from './helperConnectionsView';

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
    if (this.state.step !== 'welcome') await this.save({ ...this.state, completed: false, step: 'welcome' });
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
    // Reading connection status changes nothing, so it never waits on (or blocks) a setup action.
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'connections') {
      try { await handleConnectionsMessage(value as Record<string, unknown>, message => panel.webview.postMessage(message)); }
      catch (error) { await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not read connection status.' }); }
      return;
    }
    if (this.busy) { await panel.webview.postMessage({ type: 'error', text: 'Wait for the current setup action to finish.' }); return; }
    this.busy = true;
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid onboarding action.');
      const message = value as Record<string, unknown>;
      if (message.type === 'ready') { await this.publish(panel); return; }
      if (message.type === 'later') { await this.save({ ...this.state, completed: true }); panel.dispose(); return; }
      if (message.type === 'next' || message.type === 'skip') {
        await this.save(advanceOnboarding(this.state, message.type === 'skip'));
        if (this.state.completed) { panel.dispose(); return; }
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
      if (message.type === 'accounts') { await vscode.commands.executeCommand('hydra.openAccounts'); return; }
      if (await handleConnectionsMessage(message, value => panel.webview.postMessage(value))) return;
      if (message.type === 'connectProvider') {
        if (message.provider !== 'claude' && message.provider !== 'codex') throw new Error('Unknown provider.');
        await vscode.commands.executeCommand('hydra.openAccounts', message.provider, true);
        await this.publish(panel, 'Starting sign-in. No account connection has been verified.'); return;
      }
      throw new Error('Unknown onboarding action.');
    } catch (error) {
      await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Setup could not finish. Try again.' });
      await panel.webview.postMessage({ type: 'undoStatus', undo: await this.imports.status().catch(() => ({ available: false, interrupted: false })) });
    } finally { this.busy = false; }
  }
  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    // Claude and OpenAI mark geometry matches webview/ProviderLogo.tsx; see
    // media/PROVIDER-MARKS.md. The VS Code and Cursor glyphs are original,
    // generic representations (a code bracket, a pointer arrow), not
    // reproductions of either product's trademarked icon.
    const claudeMark = '<svg class="mark" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
    const codexMark = '<svg class="mark" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.795 23.856q-1.188 0-2.256-.448a6.1 6.1 0 0 1-1.9-1.247 5.8 5.8 0 0 1-1.875.306 5.8 5.8 0 0 1-2.944-.777 6.1 6.1 0 0 1-2.184-2.12q-.807-1.34-.808-2.99 0-.682.19-1.482a6.3 6.3 0 0 1-1.472-2.002 5.76 5.76 0 0 1 .024-4.85q.546-1.177 1.52-2.024a5.5 5.5 0 0 1 2.303-1.2A5.55 5.55 0 0 1 5.485 2.62 6.06 6.06 0 0 1 7.575.925 5.85 5.85 0 0 1 10.21.313q1.187 0 2.255.447a6.1 6.1 0 0 1 1.9 1.248 5.8 5.8 0 0 1 1.875-.306q1.59 0 2.944.776a5.9 5.9 0 0 1 2.16 2.12q.832 1.34.832 2.99 0 .682-.19 1.483a6.2 6.2 0 0 1 1.472 2.024q.522 1.13.522 2.378 0 1.272-.546 2.449a6.1 6.1 0 0 1-1.543 2.048 5.45 5.45 0 0 1-2.28 1.177 5.4 5.4 0 0 1-1.115 2.402 5.8 5.8 0 0 1-2.066 1.695 5.85 5.85 0 0 1-2.635.612M7.93 20.913q1.188 0 2.066-.495l4.463-2.542a.52.52 0 0 0 .238-.448v-2.024L8.95 18.676a.97.97 0 0 1-1.044 0L3.419 16.11a.7.7 0 0 1-.024.165v.282q0 1.201.57 2.213.594.99 1.639 1.554 1.044.59 2.326.589m.238-3.838q.143.07.26.07a.46.46 0 0 0 .238-.07l1.781-1.012-5.722-3.296q-.522-.306-.522-.918v-5.11a4.27 4.27 0 0 0-1.9 1.602 4.13 4.13 0 0 0-.712 2.354q0 1.155.594 2.213.593 1.06 1.543 1.601zm5.627 5.227q1.258 0 2.279-.565a4.25 4.25 0 0 0 1.614-1.554q.594-.99.594-2.213v-5.085q0-.283-.237-.424l-1.805-1.036v6.568q0 .613-.522.919l-4.487 2.566q1.163.825 2.564.824m.902-8.617v-3.202l-2.683-1.507-2.707 1.507v3.202l2.707 1.507zm-6.933-7.51q0-.612.522-.918l4.488-2.567a4.34 4.34 0 0 0-2.564-.824q-1.26 0-2.28.565a4.25 4.25 0 0 0-1.614 1.554q-.57.99-.57 2.213v5.062q0 .283.237.447l1.781 1.036zm12.061 11.253a4.13 4.13 0 0 0 1.876-1.6 4.2 4.2 0 0 0 .712-2.355q0-1.154-.593-2.213-.594-1.06-1.544-1.6l-4.44-2.543q-.142-.095-.26-.071a.46.46 0 0 0-.238.07l-1.78.99 5.745 3.319q.26.141.38.377a.9.9 0 0 1 .142.518zm-4.772-11.96q.522-.33 1.045 0l4.51 2.614v-.424q0-1.13-.57-2.142a4.1 4.1 0 0 0-1.59-1.648q-1.02-.613-2.374-.613-1.187 0-2.066.495L9.545 6.292a.52.52 0 0 0-.238.448v2.025z"/></svg>';
    const vscodeMark = '<svg class="mark" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5.5 3.5 1.5 8 5.5 12.5"/><polyline points="10.5 3.5 14.5 8 10.5 12.5"/></svg>';
    const cursorMark = '<svg class="mark" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2 1.5l11 6.5-4.8 1.2L10 14 8 15l-1.8-4.8L2 13.5V1.5z"/></svg>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Welcome to Hydra</title><style nonce="${nonce}">
    *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size) var(--vscode-font-family)}main{max-width:900px;margin:0 auto;padding:44px 32px}header{display:flex;justify-content:space-between;align-items:center;height:46px;padding:0 18px;border-bottom:1px solid var(--vscode-panel-border)}.brand{font-size:13px;letter-spacing:.04em;font-weight:600;color:var(--vscode-foreground)}.layout{display:grid;grid-template-columns:150px 1fr;gap:48px;margin-top:42px}ol{list-style:none;margin:0;padding:0}nav li{padding:12px 0;color:var(--vscode-descriptionForeground);font-size:12px}nav li[aria-current=step]{color:var(--vscode-foreground);font-weight:650}nav span{font-variant-numeric:tabular-nums;margin-right:12px;color:var(--vscode-descriptionForeground)}h1{font-size:32px;line-height:1.15;font-weight:550;letter-spacing:-.035em;margin:0 0 20px}h2{font-size:16px;font-weight:550;display:flex;align-items:center}p{line-height:1.7;color:var(--vscode-descriptionForeground);max-width:500px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.13em;margin:0 0 16px;color:var(--vscode-foreground)}button{font:inherit;cursor:pointer;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:4px;padding:10px 15px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}button:disabled{opacity:.5;cursor:default}header button{height:26px;padding:0 12px;font-size:12px;border-radius:6px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.quiet{background:transparent;border-color:transparent}.quiet:hover{background:var(--vscode-toolbar-hoverBackground)}.card{border:1px solid var(--vscode-panel-border);padding:20px;margin:14px 0}.card p{margin-bottom:0}.connection-state{margin:0 0 4px;color:var(--vscode-foreground)}.connection-note{font-size:12px}.cards{display:flex;gap:14px;flex-wrap:wrap}.cards .card{flex:1;min-width:190px;padding:14px;margin:0}.cards h2{font-size:14px}.mark{opacity:.55;margin-right:7px;vertical-align:-3px;flex:none}.themes{display:flex;gap:16px;margin:24px 0}.theme{flex:1;text-align:left;padding:10px}.sample{height:90px;display:block;border:1px solid var(--vscode-panel-border);padding:16px;margin-bottom:12px}.sample::after{content:'';display:block;background:#173c2c;width:45%;height:5px;margin-top:14px}.dark{background:#141414;color:#eee}.light{background:#fafbf9;color:#18221c}footer{border-top:1px solid var(--vscode-panel-border);margin-top:34px;padding-top:22px;display:flex;gap:10px}footer .primary{margin-left:auto}#status{min-height:24px;white-space:pre-wrap}#preview{border:1px solid var(--vscode-panel-border);padding:18px;margin-top:20px}#items{max-height:220px;overflow:auto;line-height:1.8;padding-left:20px}#warnings{line-height:1.7;padding-left:20px}.categories{display:flex;gap:15px;flex-wrap:wrap;margin:18px 0}input{accent-color:var(--vscode-focusBorder)}[hidden]{display:none!important}@media(max-width:620px){main{padding:24px 18px}.layout{display:block;margin-top:24px}nav ol{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}nav li{padding:0}nav span{display:none}h1{font-size:28px}}@media(forced-colors:active){.sample{forced-color-adjust:auto}}
    </style></head><body><main><header><span class="brand">HYDRA</span><button class="quiet" data-action="later">Set up later</button></header><div class="layout"><nav aria-label="Setup progress"><ol>${onboardingSteps.map((step, index) => `<li data-step="${step}"><span>0${index + 1}</span>${({ welcome: 'Welcome', import: 'Preferences', appearance: 'Appearance', accounts: 'Providers' })[step]}</li>`).join('')}</ol></nav><div>
    <section data-page="welcome"><p class="eyebrow">Your editor. Your workflow.</p><h1>A place to build<br>with your agents.</h1><p>Bring the parts of your editor you already like. Choose an appearance, then open a project and start working.</p><div class="card"><h2>A few choices. All optional.</h2><p>Closing this tab saves your place. You can return anytime from Hydra Settings.</p></div></section>
    <section data-page="import" hidden><p class="eyebrow">01 / Preferences</p><h1>Make yourself at home.</h1><p>Preview settings, keybindings, and snippets from your existing editor. Your current Hydra preferences win on conflicts.</p><div class="actions"><button data-source="vscode">${vscodeMark}From VS Code</button><button data-source="cursor">${cursorMark}From Cursor</button><button data-source="folder">Choose profile folder…</button></div><div id="preview" tabindex="-1" hidden><h2>Review your import</h2><p id="source"></p><div class="categories">${['settings','keybindings','snippets'].map(category => `<label><input type="checkbox" data-category="${category}"> ${category} <span data-count="${category}"></span></label>`).join('')}</div><ul id="items" tabindex="0" aria-label="Preference changes"></ul><p id="truncated" hidden>Showing the first 500 entries. Totals include all entries.</p><ul id="warnings"></ul><button class="primary" id="apply">Import selected preferences</button></div><p id="recovery" hidden>An earlier import was interrupted. Undo it before importing again. Your backup is retained if newer edits prevent recovery.</p><div class="actions"><button id="undo" disabled>Undo last import</button></div><p>Accounts, histories, extensions, and task configuration are not imported.</p></section>
    <section data-page="appearance" hidden><p class="eyebrow">02 / Appearance</p><h1>Choose your perspective.</h1><p>One theme for your editor, terminals, and agents. Continuing without a choice keeps your current or imported appearance.</p><div class="themes"><button class="theme" data-mode="dark"><span class="sample dark" aria-hidden="true">Hydra</span>Dark</button><button class="theme" data-mode="light"><span class="sample light" aria-hidden="true">Hydra</span>Light</button></div><p>These choices disable automatic system theme switching. High-contrast themes remain available in editor settings.</p></section>
    <section data-page="accounts" hidden><p class="eyebrow">03 / Providers</p><h1>Connect Claude Code and Codex.</h1><p>Chat with your agents in their own extensions. Connected, they can hand independent work to Hydra heads — separate agents in their own worktrees that Hydra runs, checks, and hands back.</p>${connectionsSection({ claude: claudeMark, codex: codexMark })}</section>
    <p id="status" role="status" aria-live="polite"></p><footer><button data-action="back" id="back">Back</button><button class="quiet" data-action="skip" id="skip">Skip this step</button><button class="primary" data-action="next" id="next">Get started</button></footer></div></div></main><script nonce="${nonce}">
    const api=acquireVsCodeApi();let state,preview,busy=false,undoAvailable=false;const status=document.getElementById('status');
    function update(){document.querySelectorAll('button').forEach(button=>button.disabled=busy);document.getElementById('back').disabled=busy||state?.step==='welcome';document.getElementById('undo').disabled=busy||!undoAvailable;document.getElementById('apply').disabled=busy||!preview||![...document.querySelectorAll('[data-category]')].some(input=>input.checked&&preview.counts[input.dataset.category]>0);}
    function send(message){busy=true;status.textContent='Working…';update();api.postMessage(message);}
    document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>send({type:button.dataset.action})));
    document.querySelectorAll('[data-source]').forEach(button=>button.addEventListener('click',()=>{preview=undefined;document.getElementById('preview').hidden=true;send({type:'import',provider:button.dataset.source});}));
    document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>send({type:'appearance',mode:button.dataset.mode})));
    ${connectionsScript}
    document.querySelectorAll('[data-category]').forEach(input=>input.addEventListener('change',update));document.getElementById('apply').addEventListener('click',()=>send({type:'apply',token:preview.token,categories:[...document.querySelectorAll('[data-category]')].filter(input=>input.checked).map(input=>input.dataset.category)}));document.getElementById('undo').addEventListener('click',()=>send({type:'undo'}));
    function undo(value){undoAvailable=value.available;document.getElementById('recovery').hidden=!value.interrupted;}
    window.addEventListener('message',event=>{const m=event.data;if(m.type==='state'){const changed=state?.step!==m.state.step;state=m.state;busy=false;preview=undefined;document.getElementById('preview').hidden=true;undo(m.undo);document.querySelectorAll('[data-page]').forEach(page=>page.hidden=page.dataset.page!==state.step);document.querySelectorAll('[data-step]').forEach(row=>{if(row.dataset.step===state.step)row.setAttribute('aria-current','step');else row.removeAttribute('aria-current');});document.getElementById('next').textContent=state.step==='accounts'?'Start editing':state.step==='welcome'?'Get started':'Continue';document.getElementById('skip').hidden=state.step==='welcome'||state.step==='accounts';status.textContent=m.text;if(changed){const heading=document.querySelector('[data-page="'+state.step+'"] h1');heading.tabIndex=-1;heading.focus();}}
    if(m.type==='preview'){busy=false;preview=m.preview;status.textContent=preview?'Review the changes before importing.':'Folder selection cancelled.';if(preview){const box=document.getElementById('preview');box.hidden=false;document.getElementById('source').textContent='From '+preview.source+' into '+preview.profile;document.querySelectorAll('[data-category]').forEach(input=>{input.checked=preview.counts[input.dataset.category]>0;document.querySelector('[data-count="'+input.dataset.category+'"]').textContent='('+preview.counts[input.dataset.category]+' new)';});for(const [id,values]of [['items',preview.items.map(item=>(item.state==='add'?'Add':item.state==='conflict'?'Keep':'Skip')+' · '+item.name+(item.detail?' — '+item.detail:''))],['warnings',preview.warnings]]){const list=document.getElementById(id);list.replaceChildren();for(const text of values){const row=document.createElement('li');row.textContent=text;list.appendChild(row);}}document.getElementById('truncated').hidden=!preview.truncated;box.focus();}}
    if(m.type==='connections'){busy=false;renderConnections(m.connections);if(m.text)status.textContent=m.text;}if(m.type==='error'){busy=false;status.textContent=m.text;}if(m.type==='undoStatus')undo(m.undo);update();});api.postMessage({type:'ready'});api.postMessage({type:'connections'});
    </script></body></html>`;
  }
  dispose(): void { this.panel?.dispose(); }
}
