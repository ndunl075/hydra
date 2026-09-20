import { Event } from '../../base/common/event.js';
import { DisablementReason, IUpdateService, State } from '../../platform/update/common/update.js';

/**
 * Hydra's Windows update boundary. The upstream Win32 service must never be
 * constructed: its cache recovery and installer launch are outside Hydra's
 * signed-update protocol. Later reviewed changes can add authenticated checks
 * and user-authorized staging here without restoring that path.
 */
export class HydraUpdateService implements IUpdateService {
	declare readonly _serviceBrand: undefined;
	readonly onStateChange = Event.None;
	readonly state = State.Disabled(DisablementReason.MissingConfiguration);

	async checkForUpdates(_explicit: boolean): Promise<void> { return; }
	async downloadUpdate(_explicit: boolean): Promise<void> { throw new Error('Hydra signed downloads are not yet enabled.'); }
	async applyUpdate(): Promise<void> { throw new Error('Hydra update installation is not yet enabled.'); }
	async quitAndInstall(): Promise<void> { throw new Error('Hydra update installation is not yet enabled.'); }
	async isLatestVersion(): Promise<boolean | undefined> { return undefined; }
	async _applySpecificUpdate(_packagePath: string): Promise<void> { throw new Error('Hydra refuses externally selected update packages.'); }
	async setInternalOrg(_internalOrg: string | undefined): Promise<void> { throw new Error('Hydra refuses externally selected update channels.'); }
}
