import * as vscode from 'vscode';

/**
 * "Connect Claude Code and Codex to Hydra" (docs/Official_Extensions_Plan.md,
 * Phase 5), shared by onboarding and Settings. Modelled on Zed's external-agent
 * setup: one row per agent with its install state and one action, and a plain
 * note that each agent keeps its own sign-in and billing.
 */
export interface ProviderConnectionView {
  provider: 'claude' | 'codex';
  name: string;
  extensionInstalled: boolean;
  connected: boolean;
  current: boolean;
  error?: string;
  /** Claude only: claude-mem (and the Bun it needs) is set up. */
  memory?: 'ready' | 'missing';
}

/** Handle one connections message from a webview. Returns true when the message was ours. */
export async function handleConnectionsMessage(message: Record<string, unknown>, post: (value: unknown) => Thenable<boolean>): Promise<boolean> {
  const provider = message.provider === 'claude' || message.provider === 'codex' ? message.provider : undefined;
  let text = '';
  switch (message.type) {
    case 'connections': break;
    case 'connectHelpers': {
      if (!provider) throw new Error('Unknown provider.');
      const result = await vscode.commands.executeCommand<{ warning?: string }>('hydra.connectHelpers', provider);
      text = result?.warning || `${provider === 'claude' ? 'Claude Code (with claude-mem memory)' : 'Codex'} is connected to Hydra. New ${provider === 'claude' ? 'Claude' : 'Codex'} chats can start Hydra heads.`; break;
    }
    case 'disconnectHelpers':
      if (!provider) throw new Error('Unknown provider.');
      await vscode.commands.executeCommand('hydra.disconnectHelpers', provider);
      text = `${provider === 'claude' ? 'Claude Code' : 'Codex'} is disconnected from Hydra.`; break;
    case 'signIn':
      if (!provider) throw new Error('Unknown provider.');
      await vscode.commands.executeCommand('hydra.openAccounts', provider, true);
      text = 'Starting sign-in.'; break;
    default: return false;
  }
  const connections = await vscode.commands.executeCommand<ProviderConnectionView[]>('hydra.helperConnections');
  await post({ type: 'connections', connections, text });
  return true;
}

export function connectionsSection(marks: { claude: string; codex: string }): string {
  const row = (provider: 'claude' | 'codex', name: string, blurb: string) => `<div class="card connection" data-connection="${provider}"><h2>${marks[provider]}${name}</h2><p>${blurb}</p><p class="connection-state" data-state="${provider}">Checking…</p><div class="actions"><button class="primary" data-connect="${provider}" hidden>Connect to Hydra</button><button data-disconnect="${provider}" hidden>Disconnect</button><button class="quiet" data-signin="${provider}">Sign in</button></div></div>`;
  return `<div class="cards">${row('claude', 'Claude Code', 'Chat in the Claude Code extension. Claude can start Hydra heads for independent work, and remembers across sessions with claude-mem.')}${row('codex', 'Codex', 'Chat in the Codex extension. Codex can start Hydra heads for independent work.')}</div><p class="connection-note">Connect installs the extension if needed and adds Hydra as a tool in its user settings on this computer — never inside a project. For Claude it also sets up <a href="https://github.com/thedotmack/claude-mem">claude-mem</a> (and the Bun runtime it needs). Claude Code and Codex keep their own sign-in and billing, and you can disconnect anytime.</p>`;
}

/** Client script: expects `send(message)` and a `status` element in scope. */
export const connectionsScript = `
function renderConnections(list){for(const c of list||[]){const state=document.querySelector('[data-state="'+c.provider+'"]');if(!state)continue;
const memory=c.memory===undefined?'':c.memory==='ready'?' Memory: claude-mem on.':' Memory: claude-mem not set up yet.';
state.textContent=c.error?('Error: '+c.error):!c.connected?(c.extensionInstalled?'Not connected to Hydra.':'Not installed. Connect installs it and connects it to Hydra.'):(c.current?'Connected to Hydra.':'Connected, updating for this Hydra…')+(c.connected?memory:'');
document.querySelector('[data-connect="'+c.provider+'"]').hidden=c.connected&&c.current&&c.memory!=='missing';
document.querySelector('[data-disconnect="'+c.provider+'"]').hidden=!c.connected;}}
document.querySelectorAll('[data-connect]').forEach(b=>b.addEventListener('click',()=>send({type:'connectHelpers',provider:b.dataset.connect})));
document.querySelectorAll('[data-disconnect]').forEach(b=>b.addEventListener('click',()=>send({type:'disconnectHelpers',provider:b.dataset.disconnect})));
document.querySelectorAll('[data-signin]').forEach(b=>b.addEventListener('click',()=>send({type:'signIn',provider:b.dataset.signin})));
`;
