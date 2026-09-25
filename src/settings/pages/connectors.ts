import * as vscode from 'vscode';
import type { WrittenEntries } from '../../core/helperRegistration';
import { handleConnectionsMessage, type ProviderConnectionView } from '../../helperConnectionsView';
import type { SettingsContext, SettingsPage } from '../types';

/**
 * Connectors (Settings_And_Connectors_Plan.md, "Connectors"): one card per
 * agent with its state, the Connect/Disconnect/Sign in actions (unchanged
 * behaviour, reused from helperConnectionsView.handleConnectionsMessage —
 * onboarding keeps its own simpler section built on the same helper), the
 * claude-mem memory status with a Repair button, and a "What Hydra wrote"
 * disclosure that reads the exact entries back off disk.
 */
function card(provider: 'claude' | 'codex', name: string, blurb: string): string {
  const memoryRow = provider === 'claude'
    ? `<div class="row"><div class="row-text"><div class="row-title">claude-mem memory</div><div class="row-desc" data-memory="claude">Checking…</div></div><div class="row-action"><button data-repair-memory hidden>Repair</button></div></div>`
    : '';
  return `
    <div class="group" data-connection="${provider}">
      <h2>${name}</h2>
      <div class="row"><div class="row-text"><div class="row-title">${blurb}</div><div class="row-desc" data-state="${provider}">Checking…</div></div>
        <div class="row-action"><button class="primary" data-connect="${provider}" hidden>Connect to Hydra</button><button data-disconnect="${provider}" hidden>Disconnect</button><button class="quiet" data-signin="${provider}">Sign in</button></div></div>
      ${memoryRow}
      <details class="disclosure"><summary>What Hydra wrote</summary><div data-written="${provider}"><p class="row-desc">Loading…</p></div></details>
    </div>`;
}

export const connectorsPage: SettingsPage = {
  id: 'connectors',
  title: 'Connectors',
  rows: [
    { title: 'Claude Code', description: 'Connect Claude Code so its chats can start Hydra heads.' },
    { title: 'Codex', description: 'Connect Codex so its chats can start Hydra heads.' },
    { title: 'claude-mem memory', description: 'Repair claude-mem if Claude Code stops remembering across sessions.' },
    { title: 'What Hydra wrote', description: 'The exact user-level entries Hydra added for Claude Code and Codex.' },
  ],
  html(): string {
    return `
    <h1>Connectors</h1>
    <p class="lede">Connect Claude Code and Codex so their chats can start Hydra heads: separate agents that work on independent pieces in their own worktrees.</p>
    <div class="cards">
      ${card('claude', 'Claude Code', 'Chat in the Claude Code extension. Claude can start Hydra heads for independent work, and remembers across sessions with claude-mem.')}
      ${card('codex', 'Codex', 'Chat in the Codex extension. Codex can start Hydra heads for independent work.')}
    </div>
    <p class="connection-note">Connect installs the extension if needed and adds Hydra as a tool in its user settings on this computer — never inside a project. For Claude it also sets up <a href="https://github.com/thedotmack/claude-mem">claude-mem</a> (and the Bun runtime it needs). Claude Code and Codex keep their own sign-in and billing, and you can disconnect anytime.</p>
    `;
  },
  script: `
  function renderConnections(list){
    for (const c of list || []) {
      const state = document.querySelector('[data-state="'+c.provider+'"]');
      if (!state) continue;
      let text;
      if (c.error) text = 'Error: ' + c.error;
      else {
        const parts = [c.extensionInstalled ? ('Installed' + (c.extensionVersion ? ' (v' + c.extensionVersion + ')' : '')) : 'Not installed'];
        parts.push(c.connected ? (c.current ? 'Connected to Hydra' : 'Connected, updating for this Hydra…') : 'Not connected to Hydra');
        if (c.signedIn === 'signed-in') parts.push('Signed in');
        else if (c.signedIn === 'signed-out') parts.push('Signed out');
        text = parts.join(' · ');
      }
      state.textContent = text;
      const connectButton = document.querySelector('[data-connect="'+c.provider+'"]');
      if (connectButton) connectButton.hidden = c.connected && c.current && c.memory !== 'missing';
      const disconnectButton = document.querySelector('[data-disconnect="'+c.provider+'"]');
      if (disconnectButton) disconnectButton.hidden = !c.connected;
      if (c.provider === 'claude') {
        const memory = document.querySelector('[data-memory="claude"]');
        if (memory) memory.textContent = c.memory === 'ready' ? 'claude-mem is set up.' : c.memory === 'missing' ? 'claude-mem is not set up yet.' : 'Connect Claude Code to set up claude-mem.';
        const repair = document.querySelector('[data-repair-memory]');
        if (repair) repair.hidden = !c.connected;
      }
    }
  }
  function writtenList(container, items){
    container.replaceChildren();
    for (const item of items) {
      const label = document.createElement('p'); label.className = 'row-desc'; label.textContent = item.label; container.appendChild(label);
      const pre = document.createElement('pre'); pre.textContent = item.text || 'Not written.'; container.appendChild(pre);
    }
  }
  function renderWritten(entries){
    if (!entries) return;
    const claudeBox = document.querySelector('[data-written="claude"]');
    if (claudeBox) writtenList(claudeBox, [
      { label: 'claude mcp server (~/.claude.json)', text: entries.claude.server },
      { label: 'Allow rule (~/.claude/settings.json)', text: entries.claude.allowRule },
      { label: 'Usage-limit hook, StopFailure (~/.claude/settings.json)', text: entries.claude.limitHook },
    ]);
    const codexBox = document.querySelector('[data-written="codex"]');
    if (codexBox) writtenList(codexBox, [
      { label: 'config.toml block (~/.codex/config.toml)', text: entries.codex.config },
      { label: 'AGENTS.md block (~/.codex/AGENTS.md)', text: entries.codex.agents },
    ]);
  }
  document.querySelectorAll('[data-connect]').forEach(b=>b.addEventListener('click',()=>send({type:'connectHelpers',provider:b.dataset.connect})));
  document.querySelectorAll('[data-disconnect]').forEach(b=>b.addEventListener('click',()=>send({type:'disconnectHelpers',provider:b.dataset.disconnect})));
  document.querySelectorAll('[data-signin]').forEach(b=>b.addEventListener('click',()=>send({type:'signIn',provider:b.dataset.signin})));
  document.querySelector('[data-repair-memory]')?.addEventListener('click',()=>send({type:'repairClaudeMem'}));
  document.querySelectorAll('details.disclosure').forEach(details=>details.addEventListener('toggle',()=>{if(details.open)send({type:'writtenEntries'});}));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'connections') renderConnections(message.connections);
    if (message?.type === 'writtenEntries') renderWritten(message.entries);
  });
  `,
  async onReady(ctx: SettingsContext): Promise<void> {
    await handleConnectionsMessage({ type: 'connections' }, value => ctx.post(value));
    const entries = await vscode.commands.executeCommand<WrittenEntries>('hydra.helperWrittenEntries');
    await ctx.post({ type: 'writtenEntries', entries });
  },
  async handle(message: Record<string, unknown>, ctx: SettingsContext): Promise<boolean> {
    if (message.type === 'repairClaudeMem') {
      try {
        const result = await vscode.commands.executeCommand<{ installed: string[] }>('hydra.repairClaudeMem');
        await ctx.post({ type: 'status', text: result.installed.length ? `Repaired claude-mem: set up ${result.installed.join(' and ')}.` : 'claude-mem is already set up.' });
      } catch (error) {
        await ctx.post({ type: 'status', text: `Could not repair claude-mem: ${error instanceof Error ? error.message : String(error)}` });
      }
      const connections = await vscode.commands.executeCommand<ProviderConnectionView[]>('hydra.helperConnections');
      await ctx.post({ type: 'connections', connections });
      return true;
    }
    if (message.type === 'writtenEntries') {
      const entries = await vscode.commands.executeCommand<WrittenEntries>('hydra.helperWrittenEntries');
      await ctx.post({ type: 'writtenEntries', entries });
      return true;
    }
    const handled = await handleConnectionsMessage(message, value => ctx.post(value));
    if (handled && (message.type === 'connectHelpers' || message.type === 'disconnectHelpers')) {
      const entries = await vscode.commands.executeCommand<WrittenEntries>('hydra.helperWrittenEntries');
      await ctx.post({ type: 'writtenEntries', entries });
    }
    return handled;
  },
};
