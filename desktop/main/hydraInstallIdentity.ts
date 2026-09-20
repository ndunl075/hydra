import { lstatSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import type { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { hydraUserUninstallKey, validateDesktopInstallIdentity, type DesktopInstallIdentity } from './hydraUpdate/desktopInstallIdentity.js';

/** Main-owned observation only; no renderer path or registry key is accepted. */
export async function assertHydraInstalledUpdateIdentity(environment: IEnvironmentMainService, version: string): Promise<DesktopInstallIdentity> {
	const registry = await import('@vscode/windows-registry');
	const read = (name: string) => registry.GetStringRegKey('HKEY_CURRENT_USER', hydraUserUninstallKey, name);
	const profile = process.env['USERPROFILE'] ?? '';
	const identity = validateDesktopInstallIdentity({
		platform: process.platform, architecture: process.arch, isBuilt: environment.isBuilt, isPortable: environment.isPortable,
		userProfilePath: profile,
		appDataPath: process.env['APPDATA'] ?? '',
		localAppDataPath: process.env['LOCALAPPDATA'] ?? '',
		executablePath: process.execPath, userDataPath: environment.userDataPath,
		registeredPath: read('Inno Setup: App Path'), registeredDisplayName: read('DisplayName'),
		registeredVersion: read('DisplayVersion')
	}, version);
	for (const [candidate, isFile] of [
		[identity.installationPath, false], [identity.executablePath, true], [identity.profilePath, false]
	] as const) {
		const real = realpathSync.native(candidate);
		if (win32.normalize(real).toLowerCase() !== win32.normalize(candidate).toLowerCase())
			throw new Error('Hydra update installation identity refused: path is reparsed.');
		const info = lstatSync(candidate);
		if (info.isSymbolicLink() || (isFile ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))
			throw new Error('Hydra update installation identity refused: file type is invalid.');
	}
	return identity;
}
