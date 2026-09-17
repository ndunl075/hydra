import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

let manager: ModeController | undefined;
export function activate(context: vscode.ExtensionContext): void {
  manager = new ModeController(context);
  manager.register();
}
export function deactivate(): void { manager?.dispose(); }

class ModeController {
  private panel?: vscode.WebviewPanel;
  private mode: 'editor' | 'agents' = 'editor';
  private previousEditor?: { document: vscode.TextDocument; column: vscode.ViewColumn; selections: readonly vscode.Selection[]; range?: vscode.Range };
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  constructor(private readonly context: vscode.ExtensionContext) {}
  register(): void {
    const register = (name: string, callback: () => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, () =>
      Promise.resolve().then(callback).catch(error => vscode.window.showErrorMessage(`Hydra: ${error instanceof Error ? error.message : String(error)}`))));
    register('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    register('hydra.openAgents', () => this.openAgents());
    this.context.subscriptions.push(this.status);
    this.status.command = 'hydra.toggleMode';
    this.status.tooltip = 'Hydra: Switch Editor / Agents (Ctrl+Alt+A)';
    this.updateStatus();
    this.status.show();
  }
  private updateStatus(): void { this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agents' : 'Editor'}`; }
  private async openAgents(): Promise<void> {
    if (this.mode !== 'agents') {
      const editor = vscode.window.activeTextEditor;
      this.previousEditor = editor ? { document: editor.document, column: editor.viewColumn || vscode.ViewColumn.One, selections: editor.selections, range: editor.visibleRanges[0] } : undefined;
    }
    this.mode = 'agents';
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('hydra.manager', 'Hydra · Agents', vscode.ViewColumn.One, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
      });
      this.panel = panel;
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'hydra.svg');
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        if (this.panel === panel) this.panel = undefined;
        this.mode = 'editor';
        this.updateStatus();
      }, undefined, this.context.subscriptions);
      panel.webview.onDidReceiveMessage((value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if ((value as { type?: unknown }).type === 'editor') void this.openEditor().catch(error => vscode.window.showErrorMessage(`Hydra: ${String(error)}`));
      }, undefined, this.context.subscriptions);
    } else this.panel.reveal(vscode.ViewColumn.One);
    this.updateStatus();
  }
  private async openEditor(): Promise<void> {
    this.mode = 'editor';
    this.panel?.dispose();
    const previous = this.previousEditor;
    if (previous && !previous.document.isClosed) {
      const editor = await vscode.window.showTextDocument(previous.document, { viewColumn: previous.column, preview: false });
      editor.selections = [...previous.selections];
      if (previous.range) editor.revealRange(previous.range, vscode.TextEditorRevealType.Default);
    } else await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    this.updateStatus();
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Hydra</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose(): void { this.panel?.dispose(); }
}
