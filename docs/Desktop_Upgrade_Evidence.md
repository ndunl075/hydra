# Distinct-version Windows upgrade evidence

`scripts/desktop-upgrade-evidence.mjs` is a read-only parser for evidence copied from the existing `scripts/desktop-upgrade-test.ps1` disposable GitHub-hosted Windows run. It does not install or uninstall Hydra, open an installer, read a developer profile, change a shortcut, or accept a release gate.

The parser needs the pinned `desktop/upgrade-baseline.json`, the current `package.json`, the current installer that was tested, the PowerShell transcript, `provenance.json` written by the PowerShell script, and the four generated installer logs. Run it only against an explicit evidence directory:

```powershell
node scripts/desktop-upgrade-evidence.mjs `
  --baseline desktop/upgrade-baseline.json `
  --manifest package.json `
  --prior-installer evidence\HydraSetup-prior.exe `
  --current-installer .desktop\code-oss\.build\win32-x64\user-setup\HydraSetup.exe `
  --output .desktop\upgrade-test-logs\output.txt `
  --provenance .desktop\upgrade-test-logs\provenance.json `
  --logs-dir .desktop\upgrade-test-logs
```

The baseline must contain the version, exact source head, Actions run and artifact IDs, artifact name/digest, prior-installer SHA-256, and a future `expiresAt` ISO timestamp. The existing pinned baseline predates this parser and has no expiry timestamp, so it deliberately blocks until a release owner refreshes the baseline from a successful disposable run. This prevents a stale downloaded artifact from being treated as current evidence.

The parser refuses a current version equal to the baseline, a transcript whose prior/current versions disagree with the pin and manifest, a prior or current installer whose hash differs, provenance whose copied prior baseline differs, and missing `shortcut-selected` or `shortcut-unselected` prior/upgrade log pairs. It outputs a small JSON provenance record only after these checks.

Every successful parser record has `localParser.acceptance` set to `pending-disposable-windows-run`. A local parse verifies consistency of supplied files; it cannot establish that the installer executed on a disposable Windows runner or that its user/profile preservation claims were observed. The release owner must review and accept the hosted run separately. Signing, visible wizard review, distribution, and automatic updates remain separate gates.
