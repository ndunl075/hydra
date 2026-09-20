import { win32 } from 'node:path';

export const hydraUserInstallerAppId = '{{4C372D32-54B2-43D8-8C63-ECC31D3744A8}' as const;
export const hydraUserUninstallKey = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${hydraUserInstallerAppId.slice(1)}_is1`;

export interface DesktopInstallObservation {
  platform: string;
  architecture: string;
  isBuilt: boolean;
  isPortable: boolean;
  userProfilePath: string;
  appDataPath: string;
  localAppDataPath: string;
  executablePath: string;
  userDataPath: string;
  registeredPath: string | undefined;
  registeredDisplayName: string | undefined;
  registeredVersion: string | undefined;
}

export interface DesktopInstallIdentity {
  readonly installationPath: string;
  readonly executablePath: string;
  readonly profilePath: string;
  readonly version: string;
  readonly userInstallerAppId: typeof hydraUserInstallerAppId;
}

function refuse(reason: string): never { throw new Error(`Hydra update installation identity refused: ${reason}`); }
function samePath(left: string, right: string): boolean {
  return win32.isAbsolute(left) && win32.isAbsolute(right) &&
    win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** Pure first-channel policy. Filesystem and registry observations come from Electron main. */
export function validateDesktopInstallIdentity(observation: DesktopInstallObservation, installedVersion: string): DesktopInstallIdentity {
  if (observation.platform !== 'win32' || observation.architecture !== 'x64' || !observation.isBuilt || observation.isPortable)
    refuse('runtime target is unsupported.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(installedVersion)) refuse('installed version is invalid.');
  const profile = observation.userProfilePath;
  if (!/^[A-Za-z]:\\/.test(profile) || win32.parse(profile).root.toLowerCase() === win32.normalize(profile).toLowerCase())
    refuse('user profile is invalid.');
  const roaming = win32.join(profile, 'AppData', 'Roaming');
  const local = win32.join(profile, 'AppData', 'Local');
  const install = win32.join(local, 'Programs', 'Hydra');
  const executable = win32.join(install, 'Hydra.exe');
  const data = win32.join(roaming, 'Hydra');
  if (!samePath(observation.appDataPath, roaming) || !samePath(observation.localAppDataPath, local) ||
      !samePath(observation.executablePath, executable) || !samePath(observation.userDataPath, data))
    refuse('default per-user paths do not match.');
  if (!observation.registeredPath || !samePath(observation.registeredPath, install) ||
      observation.registeredDisplayName !== 'Hydra' || observation.registeredVersion !== installedVersion)
    refuse('per-user Inno registration does not match.');
  return Object.freeze({ installationPath: install, executablePath: executable, profilePath: data,
    version: installedVersion, userInstallerAppId: hydraUserInstallerAppId });
}
