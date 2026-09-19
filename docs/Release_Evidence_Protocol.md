# Desktop release-evidence protocol

`scripts/verify-release-evidence.ps1` is a local, read-only preflight. It checks a supplied JSON manifest against the files beside that manifest. It does not build, sign, install, uninstall, alter a registry key, write a shortcut, launch Hydra, submit provider work, distribute an artifact, or check for updates.

Run it from the repository with an explicitly selected manifest:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release-evidence.ps1 -ManifestPath path\to\release-evidence.json -WhatIf
```

`-WhatIf` is accepted so the command can be used in a release review. The preflight is already read-only; the switch does not turn a blocked result into a pass.

## Manifest contract

The manifest uses schema version `1` and every referenced file path is relative to the manifest directory. The checker rejects absolute paths, parent traversal, missing files, and hashes that do not match the lowercase SHA-256 supplied in the manifest.

```json
{
  "schemaVersion": 1,
  "installer": { "path": "HydraSetup-current.exe", "sha256": "<64 lowercase hex characters>" },
  "runtime": [
    { "path": "Hydra.exe", "sha256": "<64 lowercase hex characters>" }
  ],
  "shortcutClaims": [
    { "selected": false, "evidence": { "path": "shortcut-unselected.log", "sha256": "<64 lowercase hex characters>" } },
    { "selected": true, "evidence": { "path": "shortcut-selected.log", "sha256": "<64 lowercase hex characters>" } }
  ],
  "priorVersionBaseline": {
    "version": "0.13.0",
    "sourceCommit": "<40 lowercase hex characters>",
    "installer": { "path": "HydraSetup-prior.exe", "sha256": "<64 lowercase hex characters>" }
  },
  "gates": {
    "signing": "missing",
    "manual": [
      { "id": "distinct-version-upgrade", "status": "pending" },
      { "id": "installer-wizard", "status": "pending" }
    ]
  }
}
```

The release remains blocked until signing is `verified` and each manually performed release gate is `verified`. A missing, pending, failed, or unknown gate therefore never becomes a release claim. The two shortcut claims are separate and each must be bound to its own hash-verified local evidence file. The prior-version installer is also independently hash-verified, so an upgrade baseline cannot silently point at a different artifact.

Passing this preflight only establishes that the supplied local evidence record is complete and internally consistent. It does not claim that a disposable Windows run happened, that the installer is signed, or that distribution and update channels are ready.
