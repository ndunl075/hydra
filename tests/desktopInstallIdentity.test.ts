import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { hydraUserInstallerAppId, hydraUserUninstallKey, validateDesktopInstallIdentity, type DesktopInstallObservation } from '../src/core/desktopInstallIdentity';

const profile = 'C:\\Users\\Nico';
const version = '0.22.0';
const valid: DesktopInstallObservation = {
  platform: 'win32', architecture: 'x64', isBuilt: true, isPortable: false,
  userProfilePath: profile, appDataPath: `${profile}\\AppData\\Roaming`, localAppDataPath: `${profile}\\AppData\\Local`,
  executablePath: `${profile}\\AppData\\Local\\Programs\\Hydra\\Hydra.exe`,
  userDataPath: `${profile}\\AppData\\Roaming\\Hydra`,
  registeredPath: `${profile}\\AppData\\Local\\Programs\\Hydra`,
  registeredDisplayName: 'Hydra', registeredVersion: version
};

test('first update channel binds the executable, profile, and Inno registration', () => {
  const identity = validateDesktopInstallIdentity(valid, version);
  assert.equal(identity.installationPath, valid.registeredPath);
  assert.equal(identity.profilePath, valid.userDataPath);
  assert.equal(identity.version, version);
  const product = JSON.parse(readFileSync(join(process.cwd(), 'desktop', 'product.json'), 'utf8'));
  assert.equal(hydraUserInstallerAppId, product.win32x64UserAppId);
  assert.equal(hydraUserUninstallKey, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{4C372D32-54B2-43D8-8C63-ECC31D3744A8}_is1');
});

test('archive, portable, custom profile, relocated app data, and mismatched registration refuse', () => {
  for (const change of [
    { isPortable: true }, { isBuilt: false }, { architecture: 'arm64' },
    { executablePath: 'C:\\Hydra\\Hydra.exe' },
    { executablePath: 'C:\\Program Files\\Hydra\\Hydra.exe' },
    { userDataPath: 'C:\\temp\\Hydra' },
    { appDataPath: 'C:\\temp\\Roaming' },
    { registeredPath: 'C:\\Other\\Hydra' },
    { registeredPath: undefined },
    { registeredDisplayName: 'Code' },
    { registeredVersion: '0.21.0' },
    { userProfilePath: '\\\\server\\share\\Nico' }
  ]) {
    assert.throws(() => validateDesktopInstallIdentity({ ...valid, ...change }, version), /identity refused/, JSON.stringify(change));
  }
});
