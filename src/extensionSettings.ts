import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { SettingsImport } from './extensionImport';
import type { ImportCategory } from './core/profileImport';

export class AppearanceSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly extensionUri: vscode.Uri, private readonly imports: SettingsImport) {
    this.subscription = vscode.window.onDidChangeActiveColorTheme(() => this.publish());
  }
  show(): void {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('hydra.settings', 'Hydra · Settings', vscode.ViewColumn.Active, { enableScripts: true });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'hydra-logo.png');
    panel.webview.html = this.html();
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        if (!message || typeof message !== 'object') throw new Error('Invalid settings action.');
        const action = message as Record<string, unknown>;
        if (action.type === 'ready') { this.publish(); await this.publishImportStatus(); return; }
        if (action.type === 'accounts') { await vscode.commands.executeCommand('hydra.openAccounts'); return; }
        if (action.type === 'onboarding') { await vscode.commands.executeCommand('hydra.openOnboarding'); return; }
        if (action.type === 'editorSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'hydra'); return; }
        if (action.type === 'previewImport') {
          if (!['vscode', 'cursor', 'folder'].includes(String(action.provider))) throw new Error('Unknown import source.');
          const preview = await this.imports.choose(action.provider as 'vscode' | 'cursor' | 'folder');
          await panel.webview.postMessage({ type: preview ? 'importPreview' : 'importCancelled', preview }); return;
        }
        if (action.type === 'applyImport') {
          if (typeof action.token !== 'string' || !Array.isArray(action.categories)) throw new Error('Invalid import selection.');
          const files = await this.imports.apply(action.token, action.categories as ImportCategory[]);
          await panel.webview.postMessage({ type: 'importDone', text: `Imported preferences into ${files} file${files === 1 ? '' : 's'}. Existing preferences were preserved.` });
          await this.publishImportStatus(); return;
        }
        if (action.type === 'undoImport') {
          await this.imports.undo(); await panel.webview.postMessage({ type: 'importDone', text: 'Restored the preferences from before the last import.' }); await this.publishImportStatus(); return;
        }
        if (action.type !== 'appearance' || !['dark', 'light'].includes(String(action.mode))) throw new Error('Unknown appearance choice.');
        await this.setAppearance(action.mode as 'dark' | 'light');
      } catch (error) {
        await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not change appearance.' });
        if (this.imports.available) await this.publishImportStatus().catch(() => {});
      }
    });
  }
  private async publishImportStatus(): Promise<void> {
    await this.panel?.webview.postMessage({ type: 'importStatus', ...await this.imports.status() });
  }
  async setAppearance(mode: 'dark' | 'light'): Promise<void> {
    if (mode !== 'dark' && mode !== 'light') throw new Error('Unknown appearance choice.');
    const theme = mode === 'dark' ? 'Hydra Dark' : 'Hydra Light';
    const workbench = vscode.workspace.getConfiguration('workbench');
    const configured = workbench.inspect<string>('colorTheme');
    const automatic = vscode.workspace.getConfiguration('window').inspect<boolean>('autoDetectColorScheme');
    if (configured?.workspaceValue !== undefined || configured?.workspaceFolderValue !== undefined || automatic?.workspaceValue !== undefined || automatic?.workspaceFolderValue !== undefined) {
      throw new Error('This workspace overrides appearance. Change its theme in the editor settings before using a user-wide Hydra appearance choice.');
    }
    // Only an explicit appearance click changes the user's native workbench theme.
    await workbench.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('window').update('autoDetectColorScheme', false, vscode.ConfigurationTarget.Global);
    this.publish(`Applied ${theme}.`);
  }
  private publish(status = ''): void {
    const kind = vscode.window.activeColorTheme.kind;
    void this.panel?.webview.postMessage({ type: 'appearance', mode: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark', status });
  }
  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Hydra Settings</title>
      <style nonce="${nonce}">
        * { box-sizing: border-box; } body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size) var(--vscode-font-family); }
        main { max-width: 760px; margin: 0 auto; padding: 40px 28px; } header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 22px; }
        h1 { font-size: 24px; font-weight: 500; margin: 0 0 8px; } h2 { font-size: 16px; font-weight: 500; margin: 0 0 8px; } p { line-height: 1.65; margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
        section { padding: 28px 0; border-bottom: 1px solid var(--vscode-panel-border); } .choices { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
        button { cursor: pointer; font: inherit; border-radius: 4px; padding: 9px 16px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
        button:hover { background: var(--vscode-button-secondaryHoverBackground); } button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; } button:disabled { cursor: default; opacity: .5; }
        .choice { width: 180px; padding: 10px; text-align: left; } .choice[aria-pressed="true"] { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
        .sample { display: block; height: 62px; border-radius: 2px; margin-bottom: 10px; padding: 12px; font-size: 12px; } .dark { background: #141414; color: #f5f5f5; } .light { background: #fafbf9; color: #18221c; } .sample span { display: inline-block; width: 32px; height: 5px; background: #173c2c; margin-top: 7px; }
        #status { min-height: 22px; margin-top: 20px; color: var(--vscode-foreground); } @media (forced-colors: active) { .sample { forced-color-adjust: auto; border: 1px solid CanvasText; } }
        .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; } .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); } .primary:hover { background: var(--vscode-button-hoverBackground); }
        #preview { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 18px; margin-top: 18px; } #preview p { overflow-wrap: anywhere; } .categories { display: flex; flex-wrap: wrap; gap: 18px; margin: 18px 0; } input { accent-color: var(--vscode-focusBorder); } input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
        #import-items { max-height: 260px; overflow: auto; padding-left: 22px; line-height: 1.7; overflow-wrap: anywhere; } #import-warnings { color: var(--vscode-descriptionForeground); line-height: 1.7; } [hidden] { display: none !important; }
      </style></head><body><main><header><h1>Settings</h1><p>Make Hydra feel like your editor.</p></header>
      ${this.imports.available ? '<section aria-labelledby="setup-heading"><h2 id="setup-heading">Set up Hydra</h2><p>Continue your setup or revisit imports, appearance, and provider accounts.</p><button id="onboarding">Open onboarding</button> <button id="accounts">Provider accounts</button></section>' : ''}
      <section aria-labelledby="appearance"><h2 id="appearance">Appearance</h2><p>Choose a theme for the editor, terminals, and agent manager. Both use Hydra's dark green accents.</p>
      <div class="choices" role="group" aria-label="Appearance"><button class="choice" data-mode="dark" aria-pressed="false"><span class="sample dark" aria-hidden="true">Hydra<br><span></span></span>Dark</button><button class="choice" data-mode="light" aria-pressed="false"><span class="sample light" aria-hidden="true">Hydra<br><span></span></span>Light</button></div>
      <p>Choosing a mode applies it to your user profile and turns off automatic system dark/light switching. High-contrast settings remain available in the editor.</p></section>
      ${this.imports.available ? `<section aria-labelledby="import-heading"><h2 id="import-heading">Import preferences</h2><p>Bring your settings, keybindings, and snippets from another editor. Preview what will change; current Hydra preferences win on conflicts. Accounts and conversation history stay with their provider.</p>
      <div class="actions"><button data-import="vscode">From VS Code</button><button data-import="cursor">From Cursor</button><button data-import="folder">Choose profile folder…</button></div>
      <div id="preview" tabindex="-1" aria-labelledby="import-preview-heading" hidden><h3 id="import-preview-heading">Import preview</h3><p id="import-source"></p><div class="categories">${['settings', 'keybindings', 'snippets'].map(category => `<label><input type="checkbox" data-category="${category}" checked> ${category[0]!.toUpperCase() + category.slice(1)} <span data-count="${category}"></span></label>`).join('')}</div><p>Add brings a new preference. Keep preserves a conflict. Skip leaves an unavailable, account, or existing preference unchanged.</p><ul id="import-items" tabindex="0" aria-label="Preference changes"></ul><p id="import-truncated" hidden>Showing the first 500 entries. Category totals include all entries.</p><ul id="import-warnings"></ul><div class="actions"><button class="primary" id="apply-import">Import selected preferences</button><button id="cancel-import">Cancel preview</button></div></div>
      <div class="actions"><button id="undo-import" disabled>Undo last import</button></div><p id="import-recovery" hidden>The last import was interrupted. Undo it before importing again. Backups are retained if newer edits prevent safe recovery.</p><p id="import-status" role="status" aria-live="polite"></p></section>` : ''}
      <section aria-labelledby="editor"><h2 id="editor">Editor and providers</h2><p>Change provider paths, worktree location, concurrency, and other editor preferences.</p><button id="editor-settings">Open editor settings</button></section><p id="status" role="status" aria-live="polite"></p></main>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi(); const status = document.getElementById('status'); const choices = [...document.querySelectorAll('[data-mode]')];
        for (const button of choices) button.addEventListener('click', () => { choices.forEach(choice => choice.disabled = true); status.textContent = 'Applying appearance…'; vscode.postMessage({type:'appearance',mode:button.dataset.mode}); });
        document.getElementById('editor-settings').addEventListener('click', () => vscode.postMessage({type:'editorSettings'}));
        document.getElementById('accounts')?.addEventListener('click', () => vscode.postMessage({type:'accounts'}));
        document.getElementById('onboarding')?.addEventListener('click', () => vscode.postMessage({type:'onboarding'}));
        window.addEventListener('message', event => { const message = event.data; if (message?.type === 'appearance') { choices.forEach(button => {button.disabled = false; button.setAttribute('aria-pressed', String(button.dataset.mode === message.mode));}); status.textContent = message.status || ''; } if (message?.type === 'error') { choices.forEach(button => button.disabled = false); status.textContent = message.text; } });
        vscode.postMessage({type:'ready'});
        const importStatus = document.getElementById('import-status');
        if (importStatus) {
          let preview, busy = false, undoAvailable = false;
          const sources = [...document.querySelectorAll('[data-import]')], categories = [...document.querySelectorAll('[data-category]')], apply = document.getElementById('apply-import'), undo = document.getElementById('undo-import'), panel = document.getElementById('preview');
          function update() { sources.forEach(button => button.disabled = busy); categories.forEach(input => input.disabled = busy); apply.disabled = busy || !preview || !categories.some(input => input.checked && preview.counts[input.dataset.category] > 0); undo.disabled = busy || !undoAvailable; document.getElementById('cancel-import').disabled = busy; }
          function request(message, text) { busy = true; importStatus.textContent = text; update(); vscode.postMessage(message); }
          sources.forEach(button => button.addEventListener('click', () => { preview = undefined; panel.hidden = true; request({type:'previewImport',provider:button.dataset.import}, 'Reading preferences…'); }));
          categories.forEach(input => input.addEventListener('change', update));
          apply.addEventListener('click', () => request({type:'applyImport',token:preview.token,categories:categories.filter(input => input.checked).map(input => input.dataset.category)}, 'Importing preferences…'));
          undo.addEventListener('click', () => request({type:'undoImport'}, 'Restoring preferences…'));
          document.getElementById('cancel-import').addEventListener('click', () => { preview = undefined; panel.hidden = true; importStatus.textContent = 'Preview cancelled.'; update(); sources[0].focus(); });
          window.addEventListener('message', event => {
            const message = event.data;
            if (message?.type === 'importPreview') {
              preview = message.preview; busy = false; panel.hidden = false;
              document.getElementById('import-source').textContent = 'From ' + preview.source + ' into Hydra’s ' + preview.profile + ' profile.';
              categories.forEach(input => { input.checked = preview.counts[input.dataset.category] > 0; document.querySelector('[data-count="' + input.dataset.category + '"]').textContent = '(' + preview.counts[input.dataset.category] + ' new)'; });
              const list = document.getElementById('import-items'); list.replaceChildren(); for (const item of preview.items) { const row = document.createElement('li'); row.textContent = (item.state === 'add' ? 'Add' : item.state === 'conflict' ? 'Keep' : 'Skip') + ' · ' + item.name + (item.detail ? ' — ' + item.detail : ''); list.appendChild(row); }
              const warnings = document.getElementById('import-warnings'); warnings.replaceChildren(); for (const text of preview.warnings) { const row = document.createElement('li'); row.textContent = text; warnings.appendChild(row); }
              document.getElementById('import-truncated').hidden = !preview.truncated; importStatus.textContent = 'Preview ready. Choose what to import.';
            }
            if (message?.type === 'importDone') { busy = false; preview = undefined; panel.hidden = true; importStatus.textContent = message.text; }
            if (message?.type === 'importCancelled') { busy = false; importStatus.textContent = 'Folder selection cancelled.'; }
            if (message?.type === 'importStatus') { undoAvailable = message.available; document.getElementById('import-recovery').hidden = !message.interrupted; }
            if (message?.type === 'error') { busy = false; importStatus.textContent = message.text; }
            update();
            if (message?.type === 'importPreview') panel.focus();
            if (message?.type === 'importDone') sources[0].focus();
          });
        }
      </script></body></html>`;
  }
  dispose(): void { this.subscription.dispose(); this.panel?.dispose(); }
}
