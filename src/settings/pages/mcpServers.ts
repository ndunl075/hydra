import type { SettingsPage } from '../types';

/** MCP servers: placeholder for the Phase 4 agent (src/core/mcpServers.ts + this page's UI). */
export const mcpServersPage: SettingsPage = {
  id: 'mcpServers',
  title: 'MCP servers',
  rows: [
    { title: 'MCP servers', description: 'Manage your other MCP servers for Claude Code and Codex from one place.' },
  ],
  html(): string {
    return `
    <h1>MCP servers</h1>
    <p class="lede">Manage your other MCP servers for both agents from one place.</p>
    <div class="group">
      <div class="row"><div class="row-text"><div class="row-title">MCP servers</div><div class="row-desc">List, add, remove and test MCP servers shared by Claude Code and Codex.</div></div><div class="row-action"><span class="chip">Coming soon</span></div></div>
    </div>
    `;
  },
};
