# Windows executable release identity

The accepted Hydra 0.22.0 standalone artifact from Windows run 35485520776 had `ProductName: Hydra` and `CompanyName: Nico Dunlap`, but its PE `ProductVersion` and `FileVersion` still read `1.113.0`, the pinned Code - OSS API version. The product record and bundled Hydra module read `0.22.0`. That mismatch blocks an exact-product/version signing preflight.

`desktop:build` now uses the pinned editor checkout's `rcedit` dependency after upstream packaging to stamp `Hydra.exe` with the Hydra package release version, before any future code signing. `desktop:verify` reads the actual Windows PE metadata and refuses if the product name, publisher, or `ProductVersion` differs from the package, product record, or bundled module. The editor API package retains its separate upstream version. Installer generation calls `desktop:verify` before packaging the already-stamped executable, and the disposable upgrade gate compares installed executable bytes with the exact CI build.

The first signed update channel still needs installed trust configuration, an owner-controlled signer and distribution origin, signed artifact verification, safe installation, and signed upgrade/refusal acceptance. A successful unsigned PE identity check alone does not satisfy those release gates.
