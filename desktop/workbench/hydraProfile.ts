import { CommandsRegistry } from '../platform/commands/common/commands.js';
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

CommandsRegistry.registerCommand('hydra.desktop.startupContext', accessor => {
	if (accessor.get(IProductService).nameShort !== 'Hydra') { throw new Error('Hydra desktop is required.'); }
	const environment = accessor.get(IWorkbenchEnvironmentService);
	return { development: environment.isExtensionDevelopment || !!environment.extensionTestsLocationURI };
});

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
// auto-opens, matching Cursor's clean landing state.
class HydraStartSurfaceLayout extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'hydra.workbench.contrib.startSurfaceLayout';

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		super();
		this.apply(this.contextService.getWorkbenchState());
		this._register(this.contextService.onDidChangeWorkbenchState(state => this.apply(state)));
	}

	private apply(state: WorkbenchState): void {
		this.layoutService.setPartHidden(state === WorkbenchState.EMPTY, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
	}
}

registerWorkbenchContribution2(HydraStartSurfaceLayout.ID, HydraStartSurfaceLayout, WorkbenchPhase.AfterRestored);
