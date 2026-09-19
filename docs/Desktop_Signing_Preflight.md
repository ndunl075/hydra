# Desktop signing preflight

`scripts/desktop-signing-preflight.mjs` is a local, read-only verification step for already-built Windows desktop artifacts. It never creates or imports a certificate, signs an artifact, changes certificate storage, installs software, publishes a release, or makes a distribution claim.

Run it with an explicitly selected manifest:

```powershell
node scripts/desktop-signing-preflight.mjs --manifest path\to\desktop-signing.json
```

## Manifest contract

The manifest uses schema version `1`. Each artifact path is relative to the manifest directory and is rejected if it escapes that directory. Every artifact records its own exact lowercase SHA-256, plus the same exact product name and version as the manifest. The expected signer is the exact Authenticode certificate subject and uppercase SHA-1 thumbprint.

```json
{
  "schemaVersion": 1,
  "product": { "name": "Hydra", "version": "0.22.0" },
  "expectedSigner": {
    "subject": "CN=Example Publisher, O=Example Organization",
    "thumbprint": "0123456789ABCDEF0123456789ABCDEF01234567"
  },
  "artifacts": [
    {
      "path": "HydraSetup.exe",
      "sha256": "<64 lowercase hexadecimal characters>",
      "product": "Hydra",
      "version": "0.22.0"
    }
  ]
}
```

For each artifact, the checker reads the bytes to calculate SHA-256, then asks Windows for Authenticode status and file-version metadata. It passes only when the status is `Valid`, the embedded `ProductName` and `ProductVersion` exactly match the manifest, and both the certificate subject and thumbprint exactly match `expectedSigner`.

Unsigned artifacts, invalid or untrusted signatures, altered bytes, product/version mismatches, and signer mismatches block the preflight. A pass only verifies the supplied local files against this manifest; it does not assert certificate ownership, storage policy, release approval, distribution readiness, or an installer acceptance run.
