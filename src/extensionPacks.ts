import * as vscode from 'vscode';
import path from 'node:path';
import { PackService, defaultUserPacksFolder } from './core/packs/service';

/**
 * Packs in the window (docs/Packs_Plan.md): the PackService built from the
 * extension's paths and the hydra.packs.folder setting. Heads and lanes read
 * their gates through `service.gates`.
 *
 * The Packs page, its commands, the file watchers and the "This project uses
 * the Coding pack" notification come in phase 4. Whatever calls `allow` or
 * `turnOn` must be the review panel's own button: VS Code commands can be run
 * by any extension, so a public command must never allow a pack by itself.
 */
export function createPackService(context: vscode.ExtensionContext, log: (line: string) => void): PackService {
  let warned = '';
  return new PackService({
    builtin: path.join(context.extensionPath, 'packs'),
    userFolder: () => {
      const configured = (vscode.workspace.getConfiguration('hydra').get<string>('packs.folder') ?? '').trim();
      if (configured && path.isAbsolute(configured)) return configured;
      if (configured && configured !== warned) { warned = configured; log(`[packs] hydra.packs.folder must be an absolute path; using ${defaultUserPacksFolder()} instead of "${configured}".`); }
      return defaultUserPacksFolder();
    },
    storage: path.join(context.globalStorageUri.fsPath, 'packs'),
    version: String((context.extension.packageJSON as { version?: unknown } | undefined)?.version ?? '0.0.0'),
    nodeExecutable: process.execPath,
  });
}
