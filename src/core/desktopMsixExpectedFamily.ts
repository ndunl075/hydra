/**
 * A future Hydra update entry point that accepts MSIX candidates must prove a
 * candidate shares the exact installed package family and publisher before
 * treating it as a trusted update, independent of Windows' own certificate
 * trust. A different publisher produces a different MSIX package family, and
 * a *trusted* alternate-publisher certificate can install that different
 * family side by side without ever touching Hydra's registration: Windows'
 * code-signing trust is not a substitute for this expected-identity
 * comparison. See docs/Desktop_Update_Channel_ADR.md ("MSIX publisher
 * boundary"). This is a standalone, isolated increment: no production MSIX
 * update entry point exists yet, and this module performs no OS calls or
 * I/O. Callers supply both the expected (embedded, immutable) identity and
 * the candidate's reported identity from whatever source examines the
 * update artifact.
 */

export interface InstalledMsixPackageIdentity {
  /** The MSIX package Identity Name, e.g. "NicoDunlap.Hydra.Probe". */
  name: string;
  /** The MSIX package Identity Publisher, e.g. "CN=Hydra Fixture". */
  publisher: string;
  /** The Windows-computed PackageFamilyName for that name and publisher. */
  familyName: string;
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,49}$/;
const publisherPattern = /^CN=[A-Za-z0-9 ._-]{1,64}$/;
// Windows derives the 13-character suffix from name+publisher+architecture;
// this module never reproduces that algorithm, it only compares the reported
// value against an embedded expected one.
const familyNamePattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,49}_[a-z0-9]{13}$/;

function refuse(reason: string): never {
  throw new Error(`MSIX update candidate refused: ${reason}`);
}

const identityKeys = ['name', 'publisher', 'familyName'] as const;

function validated(identity: InstalledMsixPackageIdentity, label: string): InstalledMsixPackageIdentity {
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    Object.getPrototypeOf(identity) !== Object.prototype ||
    Object.keys(identity).length !== identityKeys.length ||
    !identityKeys.every(key => Object.prototype.hasOwnProperty.call(identity, key))
  ) refuse(`${label} identity shape is invalid.`);
  if (typeof identity.name !== 'string' || !namePattern.test(identity.name)) refuse(`${label} package name is invalid.`);
  if (typeof identity.publisher !== 'string' || !publisherPattern.test(identity.publisher)) refuse(`${label} publisher is invalid.`);
  if (typeof identity.familyName !== 'string' || !familyNamePattern.test(identity.familyName)) refuse(`${label} family name is invalid.`);
  return identity;
}

/**
 * Throws unless the candidate's package name, publisher, and Windows-computed
 * family name all exactly match the installed (expected) identity. Any
 * mismatch -- including a candidate signed by a certificate the host
 * trusts, under a different publisher -- is refused. This never accepts a
 * candidate merely because its signing certificate validated: certificate
 * trust and package family identity are independent checks, and only this
 * function's success proves the candidate is the same installable family as
 * the running Hydra installation.
 */
export function assertExpectedMsixPackageFamily(
  candidate: InstalledMsixPackageIdentity,
  expected: InstalledMsixPackageIdentity
): void {
  const validCandidate = validated(candidate, 'candidate');
  const validExpected = validated(expected, 'installed');
  if (
    validCandidate.name !== validExpected.name ||
    validCandidate.publisher !== validExpected.publisher ||
    validCandidate.familyName !== validExpected.familyName
  ) {
    refuse('candidate package name, publisher, or family does not match the installed identity.');
  }
}
