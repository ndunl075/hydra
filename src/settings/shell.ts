import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SettingsImport } from '../extensionImport';
import type { PackService } from '../core/packs/service';
import { settingsStyles } from './styles';
import type { SettingsContext, SettingsPage } from './types';
import { settingsPages } from './pages';

/**
 * Hydra Settings: a left nav with search, and pages of card groups with rows
 * (Cursor Settings style). Each page in src/settings/pages/ owns its own
 * html/script/handle; this shell composes the nav, search index, appearance
 * (shared with onboarding via setAppearance), and message routing.
 *
 * Exported as AppearanceSettings for extension.ts and extensionOnboarding.ts,
 * which only use the appearance methods and .show()/.dispose().
 */
export class AppearanceSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;
  private readonly pages: SettingsPage[] = settingsPages;
  constructor(private readonly context: vscode.ExtensionContext, private readonly imports: SettingsImport, private readonly packs: PackService) {
    this.subscription = vscode.window.onDidChangeActiveColorTheme(() => this.publishAppearance());
  }
  show(pageId?: string): void {
    if (this.panel) {
      this.panel.reveal();
      if (pageId) void this.panel.webview.postMessage({ type: 'showPage', id: pageId });
      return;
    }
    const panel = vscode.window.createWebviewPanel('hydra.settings', 'Hydra Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
    panel.webview.html = this.html();
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        if (!message || typeof message !== 'object') throw new Error('Invalid settings action.');
        const action = message as Record<string, unknown>;
        if (action.type === 'ready') {
          this.publishAppearance();
          for (const page of this.pages) await page.onReady?.(this.pageContext(panel));
          if (pageId) await panel.webview.postMessage({ type: 'showPage', id: pageId });
          return;
        }
        if (action.type === 'appearance') {
          if (!['dark', 'light'].includes(String(action.mode))) throw new Error('Unknown appearance choice.');
          await this.setAppearance(action.mode as 'dark' | 'light');
          return;
        }
        for (const page of this.pages) {
          if (await page.handle?.(action, this.pageContext(panel))) return;
        }
        throw new Error('Unknown settings action.');
      } catch (error) {
        await panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not complete that action.' });
      }
    });
  }
  private pageContext(panel: vscode.WebviewPanel): SettingsContext {
    return {
      extensionUri: this.context.extensionUri,
      imports: this.imports,
      globalState: this.context.globalState,
      post: value => panel.webview.postMessage(value),
      packs: this.packs,
    };
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
    this.publishAppearance(`Applied ${theme}.`);
  }
  private publishAppearance(status = ''): void {
    const kind = vscode.window.activeColorTheme.kind;
    void this.panel?.webview.postMessage({ type: 'appearance', mode: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark', status });
    if (status) void this.panel?.webview.postMessage({ type: 'status', text: status });
  }
  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    const searchIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>';
    const navItems = this.pages.map(page => `<li><button class="nav-item" role="link" data-page="${page.id}" aria-current="false">${page.title}</button></li>`).join('');
    const sections = this.pages.map(page => `<section class="page" data-page="${page.id}" hidden>${page.html(this.pageContext0())}</section>`).join('');
    const pageIndex = JSON.stringify(this.pages.map(page => ({ id: page.id, title: page.title, rows: page.rows })));
    const pageScripts = this.pages.map(page => page.script || '').join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
      <title>Hydra Settings</title>
      <style nonce="${nonce}">${settingsStyles}</style></head>
      <body>
      <div class="shell">
        <nav class="nav" aria-label="Settings sections">
          <h1>Hydra Settings</h1>
          <div class="search"><span aria-hidden="true">${searchIcon}</span><input type="search" id="settings-search" aria-label="Search settings" placeholder="Search settings"></div>
          <ul class="nav-list" id="settings-nav">${navItems}</ul>
          <p class="nav-empty" id="settings-nav-empty" hidden>No settings match your search.</p>
        </nav>
        <main class="main">${sections}</main>
      </div>
      <p id="status" role="status" aria-live="polite"></p>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const status = document.getElementById('status');
        function send(message) { status.textContent = 'Working…'; vscode.postMessage(message); }
        const pageIndex = ${pageIndex};
        const navButtons = [...document.querySelectorAll('#settings-nav [data-page]')];
        const sections = [...document.querySelectorAll('main .page')];
        const navEmpty = document.getElementById('settings-nav-empty');
        let current = pageIndex[0] ? pageIndex[0].id : '';
        function showPage(id) {
          current = id;
          sections.forEach(section => section.hidden = section.dataset.page !== id);
          navButtons.forEach(button => button.setAttribute('aria-current', button.dataset.page === id ? 'page' : 'false'));
        }
        function matches(text, query) { return text.toLowerCase().includes(query.toLowerCase()); }
        function applySearch() {
          const query = document.getElementById('settings-search').value.trim();
          let visible = 0, firstVisible;
          for (const entry of pageIndex) {
            const button = navButtons.find(item => item.dataset.page === entry.id);
            const hit = !query || matches(entry.title, query) || entry.rows.some(row => matches(row.title, query) || matches(row.description, query));
            button.hidden = !hit;
            if (hit) { visible++; if (!firstVisible) firstVisible = entry.id; }
          }
          navEmpty.hidden = visible > 0;
          if (query && firstVisible && !navButtons.find(item => item.dataset.page === current && !item.hidden)) showPage(firstVisible);
        }
        navButtons.forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
        navButtons.forEach((button, index) => button.addEventListener('keydown', event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const visible = navButtons.filter(item => !item.hidden);
          const at = visible.indexOf(button);
          const next = visible[(at + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length];
          next?.focus();
        }));
        document.getElementById('settings-search').addEventListener('input', applySearch);
        window.addEventListener('message', event => {
          const message = event.data;
          if (message?.type === 'showPage') showPage(message.id);
          if (message?.type === 'status') status.textContent = message.text || '';
          if (message?.type === 'error') status.textContent = message.text;
        });
        showPage(current);
        ${pageScripts}
        vscode.postMessage({type:'ready'});
      </script></body></html>`;
  }
  /** Page html() only needs extensionUri/imports today (rows are static); webview posts happen on 'ready'. */
  private pageContext0(): SettingsContext {
    return { extensionUri: this.context.extensionUri, imports: this.imports, globalState: this.context.globalState, post: () => Promise.resolve(true), packs: this.packs };
  }
  dispose(): void { this.subscription.dispose(); this.panel?.dispose(); }
}
