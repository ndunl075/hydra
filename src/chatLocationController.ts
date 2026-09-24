import * as vscode from 'vscode';
import { normalizeChatLocation, chatLocationPlan } from './core/chatLocation';
import { officialProviders } from './core/handoff';

/** Applies hydra.chatLocation to the installed Claude Code extension's own setting. Never touches workspace settings. */
async function applyClaudePreferredLocation(): Promise<void> {
  if (!vscode.extensions.getExtension(officialProviders.claude.extensionId)) return;
  const plan = chatLocationPlan(normalizeChatLocation(vscode.workspace.getConfiguration('hydra').get('chatLocation')));
  const claude = vscode.workspace.getConfiguration('claudeCode');
  const inspected = claude.inspect<string>('preferredLocation');
  if (inspected?.globalValue === plan.claudePreferredLocation) return;
  await claude.update('preferredLocation', plan.claudePreferredLocation, vscode.ConfigurationTarget.Global);
}

export function registerChatLocationController(context: vscode.ExtensionContext): void {
  void applyClaudePreferredLocation();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('hydra.chatLocation')) void applyClaudePreferredLocation();
  }));
}

export async function setChatLocation(mode?: 'docked' | 'tabs'): Promise<void> {
  const picked = mode ?? await vscode.window.showQuickPick([
    { label: 'Docked', description: 'Chats live in the side bar, locked in place.', value: 'docked' as const },
    { label: 'Tabs', description: 'Chats open as editor tabs, like Cursor.', value: 'tabs' as const }
  ], { title: 'Hydra: Set Chat Location' }).then(item => item?.value);
  if (!picked) return;
  await vscode.workspace.getConfiguration('hydra').update('chatLocation', picked, vscode.ConfigurationTarget.Global);
}
