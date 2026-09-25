/**
 * Where Hydra opens the Claude Code and Codex chats: docked in the side bar
 * (today's behaviour) or as editor tabs. Pure logic only, so it can be
 * unit-tested without vscode; see chatLocationController.ts for the applier.
 */
export type ChatLocation = 'docked' | 'tabs';

export function normalizeChatLocation(value: unknown): ChatLocation {
  return value === 'tabs' ? 'tabs' : 'docked';
}

export interface OpenCommand { command: string; title: string }

/** Claude Code has its own sidebar|panel setting; Codex has no location setting, so Hydra picks the open command instead. */
export interface ChatLocationPlan {
  claudePreferredLocation: 'sidebar' | 'panel';
  claudeOpen: OpenCommand;
  codexOpen: OpenCommand;
}

const plans: Record<ChatLocation, ChatLocationPlan> = {
  docked: {
    claudePreferredLocation: 'sidebar',
    claudeOpen: { command: 'claude-vscode.sidebar.open', title: 'Claude Code: Open in Side Bar' },
    codexOpen: { command: 'chatgpt.openSidebar', title: 'Codex: Open Codex Sidebar' }
  },
  tabs: {
    claudePreferredLocation: 'panel',
    claudeOpen: { command: 'claude-vscode.editor.open', title: 'Claude Code: Open in New Tab' },
    codexOpen: { command: 'chatgpt.newCodexPanel', title: 'Codex: New Codex Agent' }
  }
};

export function chatLocationPlan(mode: ChatLocation): ChatLocationPlan {
  return plans[mode];
}

export function openCommandFor(provider: 'claude' | 'codex', mode: ChatLocation): OpenCommand {
  const plan = chatLocationPlan(mode);
  return provider === 'claude' ? plan.claudeOpen : plan.codexOpen;
}
