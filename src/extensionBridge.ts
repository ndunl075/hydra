import * as vscode from 'vscode';
import { officialProviders } from './core/handoff';
import { normalizeChatLocation, openCommandFor, type OpenCommand } from './core/chatLocation';
import type { OfficialExtensionInfo, Provider } from './core/model';

function currentChatLocation(): ReturnType<typeof normalizeChatLocation> {
  return normalizeChatLocation(vscode.workspace.getConfiguration('hydra').get('chatLocation'));
}

/** The mode's preferred open command, falling back to the docked one (e.g. an older extension without a tab-open command) if the manifest doesn't contribute it. */
function resolveOpenCommand(provider: Provider, manifest: { contributes?: { commands?: { command: string }[] } } | undefined): OpenCommand {
  const contributed = new Set(manifest?.contributes?.commands?.map(command => command.command));
  const preferred = openCommandFor(provider, currentChatLocation());
  if (contributed.has(preferred.command)) return preferred;
  const docked = openCommandFor(provider, 'docked');
  return contributed.has(docked.command) ? docked : preferred;
}

export function officialExtensionInfo(provider: Provider): OfficialExtensionInfo {
  const known = officialProviders[provider];
  const extension = vscode.extensions.getExtension(known.extensionId);
  const manifest = extension?.packageJSON as { version?: string; contributes?: { commands?: { command: string }[] } } | undefined;
  const open = resolveOpenCommand(provider, manifest);
  return { provider, extensionId: known.extensionId, installed: !!extension,
    version: manifest?.version, commandTitle: open.title,
    commandAvailable: !!manifest?.contributes?.commands?.some(command => command.command === open.command) };
}
export async function openOfficialExtension(provider: Provider): Promise<void> {
  const known = officialProviders[provider];
  const info = officialExtensionInfo(provider);
  if (!info.installed) throw new Error(`${known.commandTitle.split(':')[0]} extension is not enabled in this window. Use “Find official extension” to install or enable it.`);
  if (!info.commandAvailable) throw new Error(`This extension version does not contribute the supported command. Open the Command Palette and select “${info.commandTitle}”.`);
  const extension = vscode.extensions.getExtension(known.extensionId)!;
  await extension.activate();
  const manifest = extension.packageJSON as { contributes?: { commands?: { command: string }[] } } | undefined;
  const open = resolveOpenCommand(provider, manifest);
  if (!(await vscode.commands.getCommands(true)).includes(open.command)) throw new Error(`The provider did not register its open command. Open the Command Palette and select “${open.title}”.`);
  // Open UI only. No prompt, transcript, permission override, or credentials are passed.
  await vscode.commands.executeCommand(open.command);
}
