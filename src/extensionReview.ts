import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ReviewSnapshot } from './core/review';
import { diffLabels } from './core/model';

/** Immutable, owned snapshots: provider URIs never become arbitrary filesystem/Git readers. */
export class ReviewDocuments {
  private readonly documents = new Map<string, string>();
  private bytes = 0;
  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('hydra-review', {
      provideTextDocumentContent: uri => {
        const text = this.documents.get(uri.toString());
        if (text === undefined) throw new Error('Review snapshot expired. Reopen this change from Hydra.');
        return text;
      }
    }), vscode.workspace.onDidCloseTextDocument(document => this.release(document.uri)));
  }
  private release(uri: vscode.Uri): void {
    const text = this.documents.get(uri.toString());
    if (text !== undefined) { this.bytes -= Buffer.byteLength(text); this.documents.delete(uri.toString()); }
  }
  async openLog(title: string, text: string): Promise<void> {
    const content=`${title}\n\n${text}`,bytes=Buffer.byteLength(content);
    if(this.bytes+bytes>32*1024*1024)throw new Error('Open review snapshots reached 32 MiB. Close some tabs, then retry.');
    const resource=vscode.Uri.from({scheme:'hydra-review',authority:randomBytes(12).toString('hex'),path:'/integration/checks.log'});
    this.documents.set(resource.toString(),content);this.bytes+=bytes;
    try{await vscode.window.showTextDocument(resource,{viewColumn:vscode.ViewColumn.Two,preview:false});}catch(error){this.release(resource);throw error;}
  }
  async open(taskTitle: string, worktree: string, snapshot: ReviewSnapshot): Promise<void> {
    const identity = randomBytes(12).toString('hex');
    const uri = (side: string, name: string) => vscode.Uri.from({ scheme: 'hydra-review', authority: identity, path: `/${side}/${name}` });
    const title = `${taskTitle} @ ${snapshot.head.slice(0, 8)} · ${diffLabels[snapshot.layer]} · ${snapshot.beforePath ? `${snapshot.beforePath} → ` : ''}${snapshot.path}${snapshot.left.mode !== snapshot.right.mode ? ` [${snapshot.left.mode || 'absent'} → ${snapshot.right.mode || 'absent'}]` : ''}`;
    const left = uri('before', snapshot.beforePath || snapshot.path), right = uri('after', snapshot.path);
    const textDiff = snapshot.left.kind === 'text' && snapshot.right.kind === 'text';
    const notice = uri('info', `${snapshot.path}.review.txt`);
    const entries: [vscode.Uri, string][] = textDiff ? [[left, snapshot.left.text!], [right, snapshot.right.text!]] : [[notice,
      `${title}\n\nNo text diff generated: this change includes binary, oversized, non-UTF-8, or submodule content.\n\n${JSON.stringify({ worktree, path: snapshot.path, beforePath: snapshot.beforePath, layer: diffLabels[snapshot.layer], status: snapshot.status, head: snapshot.head, capturedAt: snapshot.createdAt, before: { ...snapshot.left, text: undefined }, after: { ...snapshot.right, text: undefined } }, null, 2)}\n\nInspect this file with an appropriate native tool. This snapshot is not approval to integrate.\n`]];
    const bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry[1]), 0);
    if (this.bytes + bytes > 32 * 1024 * 1024) throw new Error('Open review snapshots reached 32 MiB. Close some diff tabs, then retry.');
    for (const [resource, text] of entries) { this.documents.set(resource.toString(), text); this.bytes += Buffer.byteLength(text); }
    try {
      if (textDiff) await vscode.commands.executeCommand('vscode.diff', left, right, title, { viewColumn: vscode.ViewColumn.Two, preview: false });
      else await vscode.window.showTextDocument(notice, { viewColumn: vscode.ViewColumn.Two, preview: false });
    } catch (error) { for (const [resource] of entries) this.release(resource); throw error; }
  }
}
