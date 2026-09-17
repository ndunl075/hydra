import * as vscode from 'vscode';
import path from 'node:path';
import { ProfileImporter, profileIdentity, detectedImportFolder, type ProfileResources, type ImportOptions, type ImportPlan, type ImportCategory } from './core/profileImport';

interface DesktopProfile extends ProfileResources { knownSettings: string[]; themes: string[]; inherited: ImportCategory[] }
export class SettingsImport {
  private plan?: ImportPlan;
  private busy = false;
  readonly available = vscode.env.appName === 'Hydra' && !vscode.env.remoteName;
  constructor(private readonly context: vscode.ExtensionContext) {}
  private async profile(): Promise<DesktopProfile> {
    if (!this.available) throw new Error('Settings import is available in the local Hydra desktop IDE.');
    const profile = await vscode.commands.executeCommand<DesktopProfile>('hydra.desktop.profileResources');
    if (!profile || ![profile.id, profile.name, profile.root, profile.settings, profile.keybindings, profile.snippets].every(value => typeof value === 'string' && value.length > 0) || !Array.isArray(profile.knownSettings) || !profile.knownSettings.every(value => typeof value === 'string') || !Array.isArray(profile.themes) || !profile.themes.every(value => typeof value === 'string') || !Array.isArray(profile.inherited) || profile.inherited.some(value => !['settings', 'keybindings', 'snippets'].includes(value))) throw new Error('Hydra desktop profile information is unavailable.');
    return profile;
  }
  private importer(profile: ProfileResources): ProfileImporter {
    return new ProfileImporter(profile, this.context.globalStorageUri.fsPath, async files => {
      const current = await this.profile();
      if (profileIdentity(current) !== profileIdentity(profile)) throw new Error('The active Hydra profile changed. Preview again.');
      const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
      if (vscode.workspace.textDocuments.some(document => document.isDirty && files.some(file => normalize(document.uri.fsPath) === normalize(file)))) throw new Error('Save or close unsaved preference files before importing or undoing.');
    });
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('An import action is already running.');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
  async status(): Promise<{ available: boolean; interrupted: boolean }> {
    if (!this.available) return { available: false, interrupted: false };
    return this.importer(await this.profile()).undoStatus();
  }
  async preview(sourceDirectory: string): Promise<ReturnType<SettingsImport['view']>> {
    return this.exclusive(async () => {
      this.plan = undefined;
      const profile = await this.profile();
      const options: ImportOptions = { knownSettings: profile.knownSettings, themes: profile.themes, commands: await vscode.commands.getCommands(true), languages: await vscode.languages.getLanguages() };
      this.plan = await this.importer(profile).preview(sourceDirectory, options);
      for (const category of profile.inherited) this.plan.warnings.push(`This profile shares ${category} with Default. Importing that category changes the shared preferences.`);
      return this.view(this.plan);
    });
  }
  private view(plan: ImportPlan) {
    return { token: plan.token, source: plan.source, profile: plan.profile.name, items: plan.items.slice(0, 500), truncated: plan.items.length > 500, warnings: plan.warnings, counts: Object.fromEntries(['settings', 'keybindings', 'snippets'].map(category => [category, plan.items.filter(item => item.category === category && item.state === 'add').length])) };
  }
  async choose(provider: 'vscode' | 'cursor' | 'folder'): Promise<ReturnType<SettingsImport['view']> | undefined> {
    await this.profile();
    if (provider !== 'folder' && provider !== 'vscode' && provider !== 'cursor') throw new Error('Unknown import source.');
    if (provider === 'folder') {
      const selection = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Choose VS Code or Cursor User / profile settings folder', openLabel: 'Preview preferences' });
      if (!selection?.[0]) return;
      return this.preview(selection[0].fsPath);
    }
    if (process.platform !== 'win32') throw new Error('Choose a settings folder on this platform.');
    return this.preview(detectedImportFolder(provider, process.env.APPDATA || ''));
  }
  async apply(token: string, categories: ImportCategory[]): Promise<number> {
    return this.exclusive(async () => {
      const plan = this.plan;
      if (!plan || token !== plan.token) throw new Error('Import preview expired. Preview again.');
      const profile = await this.profile();
      if (profileIdentity(profile) !== profileIdentity(plan.profile)) throw new Error('The active Hydra profile changed. Preview again.');
      const count = await this.importer(profile).apply(plan, categories);
      this.plan = undefined; return count;
    });
  }
  async undo(): Promise<void> { return this.exclusive(async () => { await this.importer(await this.profile()).undo(); this.plan = undefined; }); }
}
