# Windows user installer

After `desktop:build` and `desktop:smoke`, run `npm.cmd run desktop:installer` on native Windows x64. This packages the verified standalone app using the pinned upstream Inno Setup user-installer task. It produces `.desktop/code-oss/.build/win32-x64/user-setup/HydraSetup.exe`. The bundled module and product version must match the current Hydra manifest, preventing accidentally packaging a stale runtime.

The installer uses Hydra's isolated application/registry identities and logo. Installer versioning follows Hydra's module version; the editor API remains at its upstream version for extension compatibility. The artifact is currently unsigned. Code signing, release distribution, and automatic updates are not configured by this milestone.

**Create a desktop shortcut** remains unchecked on a fresh install. Inno remembers prior task selections during reinstall. An explicit opt-out removes Hydra's previous desktop shortcut; background updates retain existing shortcuts. The standard visible installer offers launch afterward. Tests suppress launching the app, file associations, and PATH changes.

The Windows desktop CI job generates the installer only after native desktop acceptance. `scripts/desktop-installer-test.ps1` refuses execution outside a disposable GitHub-hosted Windows runner. It checks fresh default-off behavior, opted-in shortcut target, remembered selection on reinstall, explicit opt-out, and uninstall cleanup. Sentinel files prove Hydra preferences/extensions, VS Code and Cursor preferences, and an unrelated project survive. Existing Hydra registration/shortcut causes refusal rather than replacement. Logs and successful installer artifacts are retained for seven days.

These are same-version reinstall tests. Upgrade acceptance between two distinct released versions, visible wizard/launch-after-install acceptance, and signing remain outstanding; do not label those verified from this check. No lifecycle test is run on a developer's personal Windows installation.

The commands and task-selection behavior follow the [official Inno Setup command-line documentation](https://jrsoftware.org/ishelp/topic_setupcmdline.htm) and [uninstaller documentation](https://jrsoftware.org/ishelp/topic_uninstcmdline.htm).
