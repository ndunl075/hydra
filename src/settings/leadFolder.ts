import * as vscode from 'vscode';
import { repositoryRoot } from '../core/worktrees';

/**
 * The lead folder (docs/Packs_Plan.md, section 3: "read from the lead's
 * folder only, never a worktree"): the first Git folder among the window's
 * workspace folders, the same folder heads and lanes use. Settings → Gates and
 * Settings → Packs both read and write this folder, not just the first
 * workspace folder, so they agree with what a head or a lane actually sees.
 */
export async function leadFolder(): Promise<string> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try { return await repositoryRoot(folder.uri.fsPath); } catch { /* not a Git folder; try the next one */ }
  }
  throw new Error('Open a project folder (a Git repository) first.');
}
