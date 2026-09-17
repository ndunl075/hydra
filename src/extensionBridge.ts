import * as vscode from 'vscode';
import { officialProviders } from './core/handoff';
import type { OfficialExtensionInfo, Provider } from './core/model';

export function officialExtensionInfo(provider: Provider): OfficialExtensionInfo {
  const known = officialProviders[provider];
  const extension = vscode.extensions.getExtension(known.extensionId);
  const manifest = extension?.packageJSON as { version?: string; contributes?: { commands?: { command: string }[] } } | undefined;
  return { provider, extensionId: known.extensionId, installed: !!extension,
    version: manifest?.version, commandTitle: known.commandTitle,
    commandAvailable: !!manifest?.contributes?.commands?.some(command => command.command === known.command) };
}
export async function openOfficialExtension(provider: Provider): Promise<void> {
  const known = officialProviders[provider];
  const info = officialExtensionInfo(provider);
  if (!info.installed) throw new Error(`${known.commandTitle.split(':')[0]} extension is not enabled in this window. Use “Find official extension” to install or enable it.`);
  if (!info.commandAvailable) throw new Error(`This extension version does not contribute the supported command. Open the Command Palette and select “${known.commandTitle}”.`);
  const extension = vscode.extensions.getExtension(known.extensionId)!;
  await extension.activate();
  if (!(await vscode.commands.getCommands(true)).includes(known.command)) throw new Error(`The provider did not register its open command. Open the Command Palette and select “${known.commandTitle}”.`);
  // Open UI only. No prompt, transcript, permission override, or credentials are passed.
  await vscode.commands.executeCommand(known.command);
}
