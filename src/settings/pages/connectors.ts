import { connectionsScript, connectionsSection, handleConnectionsMessage } from '../../helperConnectionsView';
import type { SettingsContext, SettingsPage } from '../types';

/**
 * Connectors: today's connectionsSection/connectionsScript/handleConnectionsMessage,
 * in their own page. Phase 2 redesigns this into the card style with "What
 * Hydra wrote" and the claude-mem Repair button; behaviour is unchanged here.
 */
export const connectorsPage: SettingsPage = {
  id: 'connectors',
  title: 'Connectors',
  rows: [
    { title: 'Claude Code', description: 'Connect Claude Code so its chats can start Hydra heads.' },
    { title: 'Codex', description: 'Connect Codex so its chats can start Hydra heads.' },
  ],
  html(): string {
    return `
    <h1>Connectors</h1>
    <p class="lede">Connect Claude Code and Codex so their chats can start Hydra heads: separate agents that work on independent pieces in their own worktrees.</p>
    ${connectionsSection({ claude: '', codex: '' })}
    `;
  },
  script: connectionsScript,
  async onReady(ctx: SettingsContext): Promise<void> {
    await handleConnectionsMessage({ type: 'connections' }, value => ctx.post(value));
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    return handleConnectionsMessage(message, value => ctx.post(value));
  },
};
