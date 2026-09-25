import * as vscode from 'vscode';
import { CodexLimitTracker, codexPollDelay } from './core/limitDetection';
import { LimitWatcher, workspaceOwns } from './core/limitWatcher';
import type { LimitEvent } from './core/limitEvents';
import type { ProviderQuota } from './extensionQuota';

/**
 * Limit detection for chats in the official extensions (docs/Hydra_Agent_Plan.md,
 * Phase 1). Heads report their own limits through HelperService.onLimit.
 * - Claude: event files from the StopFailure hook, via LimitWatcher.
 * - Codex: the account's rate-limit snapshot, polled while this window is focused.
 */
export class ClaudeChatLimits implements vscode.Disposable {
  private readonly watcher: LimitWatcher;
  constructor(directory: string, claudeProjectsDir: string, emit: (event: LimitEvent) => void) {
    this.watcher = new LimitWatcher({
      directory, claudeProjectsDir,
      owns: cwd => workspaceOwns((vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath))(cwd),
    });
    this.watcher.onLimit(emit);
  }
  start(): Promise<void> { return this.watcher.start(); }
  dispose(): void { this.watcher.dispose(); }
}

/**
 * Reads Codex's limits through ProviderQuota (the official CLI's app-server, no
 * model turn) every few minutes, only while this window has focus, and emits one
 * event when a limit is reached, not again until it clears. Rate limits are
 * account-wide, so this also covers the Codex extension's chats.
 */
export class CodexChatLimits implements vscode.Disposable {
  private readonly tracker = new CodexLimitTracker();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private delay = codexPollDelay(0, 'ok');
  private last = 0;
  private polling = false;
  constructor(private readonly quota: ProviderQuota, private readonly enabled: () => Promise<boolean>, private readonly emit: (event: LimitEvent) => void, private readonly log: (line: string) => void) {
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.disposables.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.tick(); }));
  }
  private async tick(): Promise<void> {
    if (this.polling || !vscode.window.state.focused || Date.now() - this.last < this.delay) return;
    this.polling = true;
    try {
      if (!await this.enabled()) return;
      this.last = Date.now();
      await this.quota.refresh();
      const state = this.quota.snapshot();
      if (state.status !== 'checked' || !state.snapshot) { this.delay = codexPollDelay(this.delay, 'failed'); return; }
      const event = this.tracker.observe(state.snapshot);
      this.delay = codexPollDelay(this.delay, this.tracker.isLimited ? 'limited' : 'ok');
      if (event) this.emit(event);
    } catch (error) {
      this.delay = codexPollDelay(this.delay, 'failed');
      this.log(`[limits] Codex limit check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.polling = false; }
  }
  dispose(): void { clearInterval(this.timer); for (const disposable of this.disposables) disposable.dispose(); }
}
