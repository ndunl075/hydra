# Native acceptance artifact kit

This kit records manual acceptance evidence. It does not automate clicks, log into an account, run an installer, start a provider, or promote a release.

Start each review with `pendingNativeAcceptanceChecklist()`. It produces pending records for onboarding, appearance/settings import, focused-workspace navigation, installer wizard, and integration/discard. A pending record contains no operator claim or artifact.

An operator can supply a version-1 record to `parseNativeAcceptanceRecord()`. A verified record requires one or more SHA-256-bound screenshots or logs. Every artifact has a relative portable path, capture time, manual-native-observation provenance, operator, host, and source commit. Missing provenance, an unsafe path, an uppercase or malformed hash, duplicate artifact IDs, or a verified record without evidence is rejected.

Passing schema validation only proves that the supplied record is well-formed. It does not prove the observation happened, validate an installer, authenticate an account, or complete a release gate.
