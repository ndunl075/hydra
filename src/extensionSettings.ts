import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export class AppearanceSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly extensionUri: vscode.Uri) {
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
        if (action.type === 'ready') { this.publish(); return; }
        if (action.type === 'editorSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'hydra'); return; }
        if (action.type !== 'appearance' || !['dark', 'light'].includes(String(action.mode))) throw new Error('Unknown appearance choice.');
        await this.setAppearance(action.mode as 'dark' | 'light');
      } catch (error) {
        await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not change appearance.' });
      }
    });
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
      </style></head><body><main><header><h1>Settings</h1><p>Make Hydra feel like your editor.</p></header>
      <section aria-labelledby="appearance"><h2 id="appearance">Appearance</h2><p>Choose a theme for the editor, terminals, and agent manager. Both use Hydra's dark green accents.</p>
      <div class="choices" role="group" aria-label="Appearance"><button class="choice" data-mode="dark" aria-pressed="false"><span class="sample dark" aria-hidden="true">Hydra<br><span></span></span>Dark</button><button class="choice" data-mode="light" aria-pressed="false"><span class="sample light" aria-hidden="true">Hydra<br><span></span></span>Light</button></div>
      <p>Choosing a mode applies it to your user profile and turns off automatic system dark/light switching. High-contrast settings remain available in the editor.</p></section>
      <section aria-labelledby="editor"><h2 id="editor">Editor and providers</h2><p>Change provider paths, worktree location, concurrency, and other editor preferences.</p><button id="editor-settings">Open editor settings</button></section><p id="status" role="status" aria-live="polite"></p></main>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi(); const status = document.getElementById('status'); const choices = [...document.querySelectorAll('[data-mode]')];
        for (const button of choices) button.addEventListener('click', () => { choices.forEach(choice => choice.disabled = true); status.textContent = 'Applying appearance…'; vscode.postMessage({type:'appearance',mode:button.dataset.mode}); });
        document.getElementById('editor-settings').addEventListener('click', () => vscode.postMessage({type:'editorSettings'}));
        window.addEventListener('message', event => { const message = event.data; if (message?.type === 'appearance') { choices.forEach(button => {button.disabled = false; button.setAttribute('aria-pressed', String(button.dataset.mode === message.mode));}); status.textContent = message.status || ''; } if (message?.type === 'error') { choices.forEach(button => button.disabled = false); status.textContent = message.text; } });
        vscode.postMessage({type:'ready'});
      </script></body></html>`;
  }
  dispose(): void { this.subscription.dispose(); this.panel?.dispose(); }
}
