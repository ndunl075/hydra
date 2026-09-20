# Desktop update-feed integrity contract

`parseDesktopUpdateFeed(manifest, current)` is a version-`1`, in-memory parser for an explicitly supplied Hydra update manifest. It accepts no URL, endpoint, credential, filesystem path, download directive, installer flag, or restart instruction. It never fetches metadata, writes state, downloads an artifact, verifies a Windows certificate, starts an updater, installs a build, or changes the current channel.

The parser is intentionally a preparation contract, not an automatic-update implementation. Hydra's desktop build currently removes Code - OSS `updateUrl`, and the installer remains unsigned. The native update-channel implementation must separately provide authenticated feed transport, certificate verification against downloaded bytes, download storage, install/restart behavior, recovery, and native upgrade/rollback acceptance.

That native decision is recorded in [Windows update channel decision](Desktop_Update_Channel_ADR.md). Its installed trust configuration, native helper, and release gates are future implementation work; this parser alone does not enable updates.

The first pure [signed metadata verifier](Desktop_Signed_Update.md) now checks a caller-supplied envelope against installed-key and sequence-floor inputs. Channel transport, durable floor storage, native signature checks, installation, and release acceptance remain pending.

## Manifest

Every object must be a plain JSON object with the exact own-property schema; unknown, missing, inherited, null-prototype, or duplicate-contract fields are refused. `sha256` is lowercase hexadecimal and seals the JSON encoding of the manifest without its own `sha256` field.

```json
{
  "version": 1,
  "product": {
    "nameShort": "Hydra",
    "applicationName": "hydra",
    "win32AppUserModelId": "Hydra.IDE"
  },
  "channel": "stable",
  "release": {
    "version": "0.23.0",
    "artifact": {
      "fileName": "HydraSetup.exe",
      "sha256": "<64 lowercase hexadecimal characters>"
    },
    "signature": {
      "status": "valid",
      "subject": "CN=Release signer",
      "thumbprint": "<40 uppercase hexadecimal characters>",
      "artifactSha256": "<the exact artifact sha256>"
    },
    "provenance": {
      "sourceCommit": "<40 lowercase hexadecimal characters>",
      "buildRunId": 123,
      "artifactSha256": "<the exact artifact sha256>"
    }
  },
  "sha256": "<SHA-256 of the unsigned manifest JSON>"
}
```

The current local identity is supplied separately with the same product object, a `stable` or `preview` channel, and an installed semantic version. The release must use the same channel and have a strictly newer version. Semantic-version numeric components, including numeric prerelease identifiers, cannot contain leading zeroes. The artifact's full SHA-256 must exactly match both signature metadata and build provenance. Product mismatches, rollback/equal versions, channel crossing, unsigned or malformed signer metadata, missing/unbound hashes, invalid provenance, and changed manifest content all refuse.

`signature.status: "valid"` is an attested manifest claim only. This pure parser has no artifact bytes or Windows trust API, so it cannot establish Authenticode validity. The existing signing preflight remains the local artifact-signature checker; a future updater must verify the downloaded artifact before any installation action.
