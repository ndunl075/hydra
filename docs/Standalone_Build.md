# Standalone Hydra editor build

Hydra is a standalone desktop IDE. Its initial agent-manager implementation is retained as a built-in module in a branded Code - OSS application; users of the bundled app do not need VS Code. The core VSIX and VS Code development host remain useful for fast tests, not final product delivery.

## Source and identity

`desktop/upstream.json` pins the official MIT-licensed editor source to tag `1.113.0`, commit `cfbea10c5ffb233ea9177d34726e6056e89913dc`. This is the initial reproducible desktop baseline, not an assertion that it is the latest release. The separate installed VS Code development test host is version `1.135.0`; passing its core tests does not replace acceptance against the pinned standalone app. Update the pin and rerun desktop acceptance together when upgrading the editor.

`desktop/product.json` supplies Hydra's application name, CLI, URL protocol, Windows registry/app IDs/mutexes, and profile names. `desktop:prepare` checks the exact checkout/root, preserves upstream MIT notices, applies the overlay, removes inherited Marketplace/update endpoints, and patches executable/installer publisher metadata. No separate gallery/update service is configured yet, and external built-in extension downloads are disabled. The source's native language/editing extensions still build from the pinned tree.

The nested editor checkout explicitly resolves `vscode` imports to its own pinned API declarations. This prevents Hydra's development `@types/vscode` package from leaking into editor compilation; upstream compiler checks remain enabled.

The owned desktop profile bridge is staged from `desktop/workbench/hydraProfile.ts` and imported into the pinned desktop entrypoint with an exact-anchor check. It returns active profile resources and available settings/themes for import; it does not access credentials or rearrange the editor. Native acceptance runs with a named profile to exercise the distinction from Default storage.

The application is `Hydra.exe`; its normal native user-data directory is the application's `Hydra` profile under Windows AppData, and extension data uses `.hydra`. Installer app IDs and mutexes are distinct from VS Code, Cursor, and Code - OSS. It must not write to their profiles. The README logo is converted into Windows icon sizes without changing the original source image. The staged Hydra module supplies Hydra Dark as an application default; existing/imported user theme choices take precedence.

The editor's upstream API version remains `1.113.0` so extension engine checks remain valid. Hydra's module version is recorded separately in product metadata. Do not change the editor API version to the module's `0.x` version.

## Build prerequisites

Initial target: native Windows x64, Node `22.22.1` or newer in major 22, supported Python, Visual Studio 2022 C++ tools/SDK, and matching Spectre-mitigated runtime, ATL, and MFC libraries. Use the [official upstream build guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute) and the pinned `.nvmrc` rather than bypassing checks. The build uses workspace-local npm/node-gyp caches. A workspace-local verified Node archive can satisfy the pin without changing the machine's global Node installation.

The first local attempt found VS2022/Python successfully but failed with MSB8040 because Spectre libraries were missing. The Windows CI runner installs those components in its disposable environment; no global compiler change is made on Nico's machine. An npm cleanup-lock warning after this failure is secondary, not the primary cause.

```powershell
npm.cmd ci
npm.cmd run desktop:prepare
npm.cmd run desktop:build
npm.cmd run desktop:verify
npm.cmd run desktop:smoke
```

`desktop:build` prepares the pinned checkout, converts the icon, builds the Hydra module, installs the upstream locked dependencies, and runs the upstream `vscode-win32-x64` packaging task. It then embeds the actual Hydra runtime, themes, and logo under the app's built-in extensions. The output is `.desktop/VSCode-win32-x64/`; source, dependencies, caches, and builds are ignored in Git.

`desktop:verify` refuses missing/invalid executables, incorrect product/profile identity, inherited Marketplace configuration, or a missing module/theme. `desktop:smoke` launches **Hydra.exe**, with a separate empty development harness so tests run against the **bundled** Hydra module rather than this source checkout. Tests assert the host name and bundled module path, then exercise modes, native appearance, worktrees, provider fixtures, diff review, persistence, and generated workspace loading. Fixtures make no model requests. These are automated native-host checks; manual visual/accessibility and authenticated provider acceptance remain separate.

## Installer and remaining work

The prepared upstream installer source uses Hydra publisher/filename/identity and retains its optional, unchecked desktop-shortcut task. This foundation does not claim an installer has been generated or install/uninstall tested. Installer bundling, updates, an extension-distribution route, skippable onboarding, settings import/rollback, provider-owned account setup, and remaining integration/discard acceptance are subsequent feature PRs. M6 remains incomplete until those gates pass.
