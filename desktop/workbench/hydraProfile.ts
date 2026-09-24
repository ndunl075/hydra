import { CommandsRegistry } from '../platform/commands/common/commands.js';
import { MenuId, MenuRegistry } from '../platform/actions/common/actions.js';
import { IProductService } from '../platform/product/common/productService.js';
import { IConfigurationRegistry, Extensions } from '../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../platform/registry/common/platform.js';
import { IUserDataProfilesService } from '../platform/userDataProfile/common/userDataProfile.js';
import { IUserDataProfileService } from './services/userDataProfile/common/userDataProfile.js';
import { IWorkbenchThemeService } from './services/themes/common/workbenchThemeService.js';
import { IWorkbenchEnvironmentService } from './services/environment/common/environmentService.js';
import { Disposable } from '../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from './common/contributions.js';
import { IWorkbenchLayoutService, Parts } from './services/layout/browser/layoutService.js';
import { IWorkspaceContextService, WorkbenchState } from '../platform/workspace/common/workspace.js';
import { IContextKeyService } from '../platform/contextkey/common/contextkey.js';

CommandsRegistry.registerCommand('hydra.desktop.startupContext', accessor => {
	if (accessor.get(IProductService).nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); }
	const environment = accessor.get(IWorkbenchEnvironmentService);
	return { development: environment.isExtensionDevelopment || !!environment.extensionTestsLocationURI };
});

// Hydra Settings leads the title bar gear (Manage) menu, above Command Palette.
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, { command: { id: 'hydra.openSettings', title: 'Hydra Settings' }, group: '0_hydra', order: 1 });

// Owned desktop API: extensions do not infer active profiles from global storage.
CommandsRegistry.registerCommand('hydra.desktop.profileResources', async accessor => {
	if (accessor.get(IProductService).nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); }
	const profile = accessor.get(IUserDataProfileService).currentProfile;
	const root = accessor.get(IUserDataProfilesService).defaultProfile.location;
	const themes = await accessor.get(IWorkbenchThemeService).getColorThemes();
	return {
		id: profile.id, name: profile.name, root: root.fsPath,
		settings: profile.settingsResource.fsPath, keybindings: profile.keybindingsResource.fsPath,
		snippets: profile.snippetsHome.fsPath,
		inherited: (['settings', 'keybindings', 'snippets'] as const).filter(category => profile.useDefaultFlags?.[category]),
		knownSettings: Object.keys(Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurationProperties()),
		themes: themes.map(theme => theme.settingsId)
	};
});

// The agent panel stays hidden on the empty start surface (no folder open) and
// reappears once a folder or workspace opens; the terminal panel never
// auto-opens, matching Cursor's clean landing state. It also hides while the
// full "Hydra · Agents" manager tab is open, since that tab already includes
// its own task-creation form and showing both duplicates the composer.
class HydraStartSurfaceLayout extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.startSurfaceLayout';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this.apply();
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.apply()));
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(['hydra.mode']))) this.apply();
		}));
	}

	private apply(): void {
		const empty = this.contextService.getWorkbenchState() === WorkbenchState.EMPTY;
		const agentsManagerOpen = this.contextKeyService.getContextKeyValue<string>('hydra.mode') === 'agents';
		this.layoutService.setPartHidden(empty || agentsManagerOpen, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
	}
}

registerWorkbenchContribution2(HydraStartSurfaceLayout.ID, HydraStartSurfaceLayout, WorkbenchPhase.AfterRestored);
