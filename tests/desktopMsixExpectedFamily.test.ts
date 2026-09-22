import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExpectedMsixPackageFamily, type InstalledMsixPackageIdentity } from '../src/core/desktopMsixExpectedFamily';

// Observed on the disposable Windows desktop CI run 35678715885 (PR #173):
// https://github.com/ndunl075/hydra/actions/runs/35678715885
const installed: InstalledMsixPackageIdentity = {
  name: 'NicoDunlap.Hydra.Probe',
  publisher: 'CN=Hydra Fixture',
  familyName: 'NicoDunlap.Hydra.Probe_3g0yk0awna3br'
};
// Same publisher as `installed`, only the version differs (N-to-N+1 upgrade):
// package family is name+publisher only, so this shares the installed family.
const upgradeCandidate: InstalledMsixPackageIdentity = { ...installed };
// The alternate-publisher fixture from the same CI run was refused by Windows
// before it ever installed, so no real family name was observed for it. A
// different publisher always produces a different family regardless of the
// suffix's exact value; this illustrative suffix is not derived from a real
// package.
const wrongPublisherCandidate: InstalledMsixPackageIdentity = {
  name: 'NicoDunlap.Hydra.Probe',
  publisher: 'CN=Hydra Alternate',
  familyName: 'NicoDunlap.Hydra.Probe_7f2k9qz3mtb1c'
};

test('accepts a same-publisher candidate matching the installed family', () => {
  assert.doesNotThrow(() => assertExpectedMsixPackageFamily(upgradeCandidate, installed));
});

test('refuses a trusted alternate-publisher candidate even though only the publisher and family changed', () => {
  assert.throws(() => assertExpectedMsixPackageFamily(wrongPublisherCandidate, installed), /does not match the installed identity/);
});

test('refuses a candidate with a different package name', () => {
  const candidate = { ...installed, name: 'NicoDunlap.Hydra.Fake' };
  assert.throws(() => assertExpectedMsixPackageFamily(candidate, installed), /does not match the installed identity/);
});

test('refuses a candidate whose family name differs despite a matching name and publisher', () => {
  const candidate = { ...installed, familyName: 'NicoDunlap.Hydra.Probe_zzzzzzzzzzzzz' };
  assert.throws(() => assertExpectedMsixPackageFamily(candidate, installed), /does not match the installed identity/);
});

test('refuses malformed candidate identities', () => {
  const cases: unknown[] = [
    null,
    undefined,
    {},
    { name: '', publisher: installed.publisher, familyName: installed.familyName },
    { name: installed.name, publisher: 'Hydra Fixture', familyName: installed.familyName },
    { name: installed.name, publisher: installed.publisher, familyName: 'not-a-family-name' },
    { name: installed.name, publisher: installed.publisher, familyName: installed.familyName, extra: 'ignored-is-still-invalid-shape' }
  ];
  for (const candidate of cases) {
    assert.throws(() => assertExpectedMsixPackageFamily(candidate as InstalledMsixPackageIdentity, installed));
  }
});

test('refuses a malformed expected (installed) identity even with a well-formed candidate', () => {
  const badInstalled = { ...installed, publisher: 'not-a-cn-value' };
  assert.throws(() => assertExpectedMsixPackageFamily(installed, badInstalled), /installed .*is invalid/);
});
