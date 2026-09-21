# Windows MSIX compatibility study

This is an opt-in feasibility study for the [desktop update trust boundary](Desktop_Update_Channel_ADR.md), not a replacement for Hydra's Inno installer or a signed release. Windows [protects installed MSIX package files](https://learn.microsoft.com/en-us/windows/msix/msix-containerization-overview) and can [check package integrity before launch](https://learn.microsoft.com/en-us/windows/msix/desktop/tamper-protection). A full-trust packaged desktop app remains a normal desktop process; package protection does not sandbox Hydra's workspaces or agents. Genuine user consent for an update is a separate requirement.

Run `node scripts/desktop-msix-compatibility-probe.mjs <absolute path to built Hydra runtime>` on Windows with the Windows SDK installed. The script copies the runtime into a UUID-named ignored `.test-build/msix-compatibility` run, stages a separate `NicoDunlap.Hydra.Probe` identity with `uap10:PackageIntegrity` enforcement, and invokes the newest installed x64 `MakeAppx.exe`. It never installs the package or modifies the source runtime. `report.json` records source/repo versions, SDK, host build, package size, and blockers. It deliberately emits an unsigned package. A fixture signature must never be confused with production signing or publisher identity.

For offline signing evidence, run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/desktop-msix-fixture-sign.ps1 -RunDirectory <absolute path to run-...>`. This copies the unsigned package, makes a one-day `CA:FALSE` code-signing fixture matching the probe publisher, signs only the copy, writes `fixture-signing.json`, and removes the private key/PFX files in `finally`. It does not import certificate trust or install the app. The remaining `.crt` is public-only test material.

## Current local evidence

Windows SDK 10.0.26100.0 packaged the available Hydra 0.16.0 runtime into a 207 MB unsigned MSIX. Inspection found 4,814 ZIP entries including the manifest, block map, executable, and built-in Hydra extension. The package was signed with a throwaway code-signing certificate held only in ignored probe scratch; the fixture private-key files were then removed. This source tree is Hydra 0.22.0, so that package is **not** a version-matched acceptance artifact.

The signed fixture was not trusted by the host. A temporary import to CurrentUser TrustedPeople did not satisfy the package's root-chain requirement: `Add-AppxPackage` returned `0x800B0109`. A second one-day `CA:FALSE` fixture, staged for temporary CurrentUser Root plus TrustedPeople testing, stopped at `UI is not allowed in this operation` in the noninteractive host. The test scripts checked cleanup; no fixture package or certificate remained installed. Consequently there is no evidence yet for launch, protected-file write refusal, terminal/native compatibility, update retention, or user consent.

An isolated attempt to build current Hydra 0.22.0 reached the pinned Code OSS `npm ci` step, then stopped in `@vscode/windows-registry` with MSBuild `MSB8040`: Spectre-mitigated C++ libraries are missing from this host's Visual Studio Build Tools. That is a local toolchain prerequisite, not an MSIX package failure. Do not relabel the older package as current to bypass it.

## Version-matched packaging evidence — 2026-09-21

The successful [Windows desktop run 35554305650](https://github.com/ndunl075/hydra/actions/runs/35554305650) built a standalone Hydra runtime at source head `83187af6b26d383a92bcf7be3ca101066e80ce97`. Its `Hydra-win32-x64` artifact (ID `10619828982`, archive SHA-256 `cfe8828a73ce0547a3f8d8fd99762c8795f9fc7414b2a55fc36c4be2976e64e4`) supplied the runtime for a second local probe. The extracted `product.json`, executable PE ProductVersion/FileVersion, and this source's `package.json` all report Hydra `0.22.0`; `product.json` retains the pinned Code OSS commit `cfbea10c5ffb233ea9177d34726e6056e89913dc`.

Windows SDK 10.0.26100.0 packaged those 4,811 runtime files into a 207,592,916-byte unsigned `0.22.0.0` MSIX (SHA-256 `815cfff9389cf48e8ae26f2c109fbf9a067205be4aade67151db5646823ec6cd`). `MakeAppx unpack` succeeded. The probe's separate fixture signer produced an untrusted signed copy (SHA-256 `a9dc8613357dae2b6a379cde6053e4b55a3f67ea04702aee327db2b2f2f21640`) and removed its private-key and PFX files. No package or fixture certificate was installed on this host. The successful CI artifact expires; these digests and the run ID preserve provenance, not future artifact availability.

This closes only the version-matched **packaging** prerequisite in acceptance step 1. A complete local build toolchain, standard-user fixture trust/install, launch and workflow checks, protected-file refusal, publisher mismatch, upgrade behavior, and update consent remain unverified. The Inno installer and disabled production update channel are unchanged.

## Required acceptance before an installer decision

1. Build and verify a version-matched Hydra desktop runtime with the pinned Node and Code OSS revisions on a complete Windows build host. The CI-built 0.22.0 runtime above satisfies this for the packaging study; a fresh local build remains blocked by missing Spectre libraries.
2. In a disposable Windows user/VM, create a short-lived fixture publisher, trust it there, install the signed package as a standard user, and prove the installed executable, built-in extension, and native DLL cannot be modified from Hydra's ordinary token. Remove fixture trust and installation afterward.
3. Launch with an isolated profile and check Hydra activation, editor, terminal, native modules, user extension install, external tools, CLI, restart, and settings persistence.
4. Verify modified package bytes and a wrong-publisher replacement refuse. Upgrade an installed version N to a correctly signed N+1 package and prove user data retention, shortcuts, CLI registration, and downgrade refusal.
5. Design and test real update consent independently of package integrity. Keep the existing native helper and production channel disabled until the chosen distribution model passes its full signed release acceptance.

## Disposable install acceptance

`scripts/desktop-msix-install-test.ps1` is restricted to GitHub-hosted Windows runners because it temporarily changes the LocalMachine Trusted People certificate store. After the normal standalone build and smoke test, it packages that exact runtime, signs a separate copy with the one-day fixture certificate, temporarily trusts only its public certificate, and installs the package. The gate verifies package identity and version, matching executable and bundled-Hydra hashes, WindowsApps placement, refusal to create or open code for write under the installed tree, rejection of a byte-modified signed package, preserved executable PE version, and launch through the registered package application identity.

The `finally` path removes the package and certificate and records whether package trust, private-key material, and PFX material are absent. Evidence uploads even when the gate fails. Passing this gate will establish fixture install and protected-payload behavior on that disposable runner. It will not establish full editor/terminal/extensions/CLI/settings workflows, N-to-N+1 package upgrades, wrong-publisher replacement, production signing, or genuine update consent.

MSIX changes installation location and potentially shortcut, CLI, extension, and update behavior. The probe establishes only that Code OSS's existing payload can be represented as a validated unsigned package on this host.
