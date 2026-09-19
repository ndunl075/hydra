# Delegation evaluation observation import

Feature 31 imports one user-selected local JSON observation bundle. The caller supplies a selected bundle directory and a single relative filename; traversal, absolute paths, symlinks, and bundles larger than 512 KiB are refused before parsing.

The bundle repeats the immutable corpus ID/hash and case ID/hash, base commit, provider, model, and effort. Its sealed ledger observation must bind to those exact values. Every named local artifact is read only from the selected directory, with symlink and size bounds, and its bytes must match the recorded SHA-256 before import. The importer stores only the 12-hex delegated-run ID, 24-hex observation ID, and observation SHA-256. It does not retain credentials, prompts, transcripts, logs, or artifact contents, and it never starts a benchmark or provider turn.

`exportEvidence` is a read-only adapter. Until the durable binding and its exact sealed observation both exist, it returns `unavailable`; otherwise it returns only `{ id, sha256 }` for delegated-run archive export. Missing measurements keep their original partial or unavailable coverage.

The command palette action **Hydra: Import Sealed Evaluation Observation** asks the user to select the immutable corpus JSON and local bundle JSON. It validates both, saves the exact corpus snapshot alongside the run binding, and never starts a provider or benchmark. **Hydra: Export Delegated Run Archive** reads only that fixed local store and includes the sealed observation ID and SHA-256 when both the stored corpus and ledger observation still match. A missing binding or older binding without a retained corpus remains `unavailable`; a changed stored corpus is refused rather than exported. The archive contains no artifact bytes.
