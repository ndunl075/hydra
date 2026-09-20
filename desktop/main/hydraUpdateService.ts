import { join } from 'node:path';
import { dialog } from 'electron';
import { Emitter, Event } from '../../base/common/event.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { DisablementReason, IUpdateService, State, StateType, UpdateType } from '../../platform/update/common/update.js';
import { checkDesktopUpdateCandidate } from './hydraUpdate/desktopUpdateCheck.js';
import { confirmedDesktopUpdateDownload } from './hydraUpdate/desktopUpdateDownloadConsent.js';
import { DesktopUpdateJournal } from './hydraUpdate/desktopUpdateJournal.js';
import { getHydraUpdateTrust, type HydraInstalledUpdateTrust } from './hydraUpdateTrust.js';

/**
 * Hydra's Windows update boundary. The upstream Win32 service must never be
 * constructed: its cache recovery and installer launch are outside Hydra's
 * signed-update protocol. Signed downloads require main-owned confirmation;
 * installation remains a separate native verification gate.
 */
export class HydraUpdateService implements IUpdateService {
	declare readonly _serviceBrand: undefined;
	private readonly stateEmitter = new Emitter<State>();
	readonly onStateChange: Event<State> = this.stateEmitter.event;
	private _state: State = State.Disabled(DisablementReason.MissingConfiguration);
	get state(): State { return this._state; }
	private readonly trust: HydraInstalledUpdateTrust | null;
	private readonly journal: DesktopUpdateJournal | null;
	private checkPromise: Promise<void> | undefined;
	private downloadPromise: Promise<void> | undefined;

	constructor(@IEnvironmentMainService private readonly environment: IEnvironmentMainService) {
		let trust: HydraInstalledUpdateTrust | null = null;
		try { trust = getHydraUpdateTrust(); } catch { /* malformed installed trust fails closed */ }
		let journal: DesktopUpdateJournal | null = null;
		if (environment.isBuilt && !environment.disableUpdates && trust) {
			try { journal = new DesktopUpdateJournal(join(environment.userDataPath, 'hydra-update-state')); }
			catch { /* invalid profile path keeps the channel disabled */ }
		}
		if (trust && journal) {
			this.trust = trust;
			this.journal = journal;
			this.setState(State.Idle(UpdateType.Setup));
		} else {
			this.trust = null;
			this.journal = null;
		}
	}

	private setState(state: State): void {
		this._state = state;
		this.stateEmitter.fire(state);
	}

	checkForUpdates(explicit: boolean): Promise<void> {
		if (!this.trust || !this.journal) return Promise.resolve();
		if (this.downloadPromise) return Promise.resolve();
		if (this.checkPromise) return this.checkPromise;
		this.checkPromise = this.performCheck(explicit).finally(() => { this.checkPromise = undefined; });
		return this.checkPromise;
	}

	private async performCheck(explicit: boolean): Promise<void> {
		const trust = this.trust!;
		const journal = this.journal!;
		this.setState(State.CheckingForUpdates(explicit));
		try {
			const { update } = await checkDesktopUpdateCandidate({
				journal, origin: trust.origin,
				current: { product: { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' }, channel: 'stable', version: trust.version },
				trust: { keyId: trust.keyId, publicKeyPem: trust.publicKeyPem, channel: 'stable', platform: 'win32', architecture: 'x64', installTarget: 'user' },
				clock: Date.now
			});
			this.setState(State.AvailableForDownload({ version: update.provenance.sourceCommit, productVersion: update.availableVersion }, false));
		} catch (error) {
			this.setState(State.Idle(UpdateType.Setup, explicit ? String(error) : undefined));
		}
	}

	downloadUpdate(explicit: boolean): Promise<void> {
		if (this.downloadPromise) return this.downloadPromise;
		if (!this.trust || !this.journal || this._state.type !== StateType.AvailableForDownload) {
			return Promise.reject(new Error('Hydra update is not available for download.'));
		}
		this.downloadPromise = this.performDownload(explicit).finally(() => { this.downloadPromise = undefined; });
		return this.downloadPromise;
	}

	private async performDownload(explicit: boolean): Promise<void> {
		const available = this._state;
		if (available.type !== StateType.AvailableForDownload) throw new Error('Hydra update is not available for download.');
		const trust = this.trust!;
		const journal = this.journal!;
		try {
			const operation = (await journal.load()).at(-1);
			if (!operation) throw new Error('Hydra update operation is missing.');
			const outcome = await confirmedDesktopUpdateDownload({
				journal, operationId: operation.id, origin: trust.origin, userDataDirectory: this.environment.userDataPath,
				current: { product: { nameShort: 'Hydra', applicationName: 'hydra', win32AppUserModelId: 'Hydra.IDE' }, channel: 'stable', version: trust.version },
				trust: { keyId: trust.keyId, publicKeyPem: trust.publicKeyPem, channel: 'stable', platform: 'win32', architecture: 'x64', installTarget: 'user' },
				clock: Date.now,
				onDownloadStart: () => this.setState(State.Downloading(available.update, explicit, false)),
				confirm: async update => {
					const choice = await dialog.showMessageBox({ type: 'question', title: 'Hydra Update',
						message: `Download Hydra ${update.availableVersion}?`,
						detail: 'Hydra will verify the downloaded installer before it can run.',
						buttons: ['Download', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
					return choice.response === 0;
				}
			});
			if (outcome.status === 'cancelled') this.setState(available);
			else {
				this.setState(State.Idle(UpdateType.Setup));
				await dialog.showMessageBox({ type: 'info', title: 'Hydra Update', message: 'Download saved',
					detail: 'Installation is unavailable until publisher verification passes.', buttons: ['OK'] });
			}
		} catch (error) {
			this.setState(State.Idle(UpdateType.Setup, String(error)));
			throw error;
		}
	}
	async applyUpdate(): Promise<void> { throw new Error('Hydra update installation is not yet enabled.'); }
	async quitAndInstall(): Promise<void> { throw new Error('Hydra update installation is not yet enabled.'); }
	async isLatestVersion(): Promise<boolean | undefined> { return this._state.type === StateType.AvailableForDownload ? false : undefined; }
	async _applySpecificUpdate(_packagePath: string): Promise<void> { throw new Error('Hydra refuses externally selected update packages.'); }
	async setInternalOrg(_internalOrg: string | undefined): Promise<void> { throw new Error('Hydra refuses externally selected update channels.'); }
}
