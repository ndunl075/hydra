# Hydra agent instructions

- Always address the user as "Nico" at some point in every response.

## Model selection

| Use this | For | Recommended effort |
| --- | --- | --- |
| **Luna** | Fast, cheap work: locate files, summarize a module, write small tests, rename/refactor a tightly specified component, reproduce a bug, review logs | Low or Medium |
| **Terra** | Your daily driver: implement a bounded feature, worktree/terminal services, React webview UI, persistence, integrations with clear acceptance tests | Medium |
| **Sol** | Complex professional engineering: cross-module refactors, hard debugging, native-process/VS Code API edge cases, security-sensitive review, design a subsystem after you know its boundaries | Medium by default; High when stuck |
| **Astra** | The hardest end-to-end decisions: decide whether the VS Code extension approach can meet your toggle UX, reconcile competing architecture options, plan a migration across the fork, solve a problem involving code + browser + tooling + research | Medium first; High only for a genuinely consequential, ambiguous problem |
