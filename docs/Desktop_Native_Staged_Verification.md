# Native staged installer verification

`native/desktop-update-staged-verifier.cpp` connects the operation-ID path lease to the Authenticode verifier. It opens the fixed staged path, holds every ancestor and the installer against rename or write, and passes that same file handle to the byte-length, SHA-256, and signer checks. A failed decision closes the lease; an accepted decision returns the still-open lease to its caller. The future helper must retain it through installer process creation.

The profile root, digest, length, and signer accepted by this primitive are test inputs, **not** production authority. An installed helper still needs to derive the Hydra profile and installed signer policy itself, authenticate the durable operation and consent, check exact Hydra PE identity, and enforce the release owner's timestamp/revocation policy. This feature has no process launch or update activation.

`scripts/desktop-native-staged-verifier-test.ps1` compiles a test-only caller and stages an existing signed browser executable under the fixed updater path. It checks accepted bytes and signer plus refusal for wrong hash, length, signer, operation ID, hard link, reparse-point ancestor, and tampered signed bytes. The Windows desktop workflow runs it before packaging. This fixture does not substitute for controlled Hydra-signed release acceptance.
