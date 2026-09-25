# Verified per-task model controls

> **Removed (2026-09-24).** This described part of Hydra's managed-task system, which was removed once the Agents view became a live canvas of Hydra heads (see [Agents_View_Plan.md](Agents_View_Plan.md), "As built", and [Heads.md](Heads.md)). Kept for history; none of it is in the product any more.

This milestone adds explicit model and reasoning-effort selection for managed Codex tasks. It preserves official provider defaults when no selection is saved. It does not introduce a project-wide override, account entitlement claims, automatic retries, or additional model calls.

Hydra 0.17.0 also provides a candidate Claude CLI control adapter with authoritative pre-prompt settings checks and scoped approvals; see [Claude controls](Claude_Controls.md). Its authenticated and full revision acceptance remain separate gates. The Codex contract below is unchanged.

## Behavior

After creating a Codex task, open **Model and effort**, load available models, choose an advertised model and effort, and save. Discovery uses the configured official Codex 0.154.0 executable with a short-lived stdio App Server connection. It sends only `initialize`, `initialized`, and paginated `model/list`. It never starts/resumes a thread, submits a prompt, or handles authentication. Catalogs are transient UI metadata; settings changes and shutdown cancel discovery. Catalogs are limited to 20 pages of 100 entries, bounded field lengths, unique model/effort identifiers, a 2 MiB output cap, and a 20-second discovery deadline. Errors and repeated cursors fail visibly.

The saved `Task.modelSelection` is `{ model, effort }`. It locks with the initial task brief before queue submission, including submissions that later fail or are cancelled, so explicit follow-ups retain the same selection. Terminal and official-extension launches are refused for explicitly configured tasks because those routes cannot acknowledge the saved selection. Clear the selection before queueing or starting the task to use those routes. Default tasks continue to send no model, effort, or reasoning-configuration override.

Each managed invocation, including a follow-up, reloads the runtime catalog and requires an exact advertised match. It sends the selected model and `config.model_reasoning_effort` on `thread/start` or `thread/resume`, validates the reported model and reasoning effort, durably records them, then sends the same model and effort on `turn/start`. A missing or mismatched acknowledgement prevents `turn/start`. The task history records requested and provider-reported values independently.

The acknowledgement is the App Server's effective thread configuration before that turn. `turn/start` does not return separate effective settings, and this check does not establish the model used for every internal service request. A matching `model/rerouted` notification replaces the displayed effective model and clears the old effort acknowledgement. For an explicit selection, Hydra marks the run as an error and stops its owned process; it submits no corrective turn. The notification can arrive after the provider has started work, so stopping cannot guarantee that no rerouted request ran. Default tasks also record rerouting without claiming the previous effort still applies.

The **Astra High** shortcut is enabled only when the runtime advertises exactly `gpt-6-astra` with `high` effort. Hydra does not infer availability, translate another model name, or silently substitute a different effort. Actual Astra availability and account access were not tested in this milestone. An advertised catalog entry is not proof of account entitlement or available quota.

## Public contract and provider boundary

The checked-in generated types come from the installed official `@openai/codex@0.154.0` binary's `app-server generate-ts` command with experimental APIs omitted. The added subset is the unmodified dependency closure for `ModelListParams`, `ModelListResponse`, and `ModelReroutedNotification`. Existing pinned thread and turn request types already support the required options. Runtime response validation checks only the fields Hydra consumes.

The [official App Server contract](https://learn.chatgpt.com/docs/app-server) documents model discovery, supported reasoning efforts, thread overrides, and rerouting. The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `model_reasoning_effort`. Local generation and fixture evidence establish protocol compatibility; they do not establish authenticated model acceptance.

Claude 2.1.270 flags alone cannot prove effective effort. The candidate adapter now checks the authoritative `get_settings.applied` response before a prompt and refuses organization/environment downgrades. Its pinned public declaration and read-only installed-CLI evidence are recorded in [Claude controls](Claude_Controls.md); real resumed-settings and tool acceptance remain pending.

## Integration and validation

`Snapshot.modelCatalogs` supplies safe per-task catalog metadata. `checkModels` loads it; `saveModelSelection` accepts a validated selection or `null`. `Turn.modelSettings` persists requested, effective, and rerouted evidence. The controls reuse `canEditBrief`, so scheduler enqueue locks must remain part of that predicate. The adapter rechecks its stopped state after the new catalog and durable effective-settings awaits before submitting a turn; preserve the scheduler's separate pre-spawn cancellation guards when combining branches.

`npm run check`, `npm run build`, and 52 initial local fixture tests passed on Windows. New process fixtures cover metadata-only requests, cancellation, pagination, malformed/duplicate metadata, unavailable models, provider clamps, absent acknowledgement, exact first/resumed turn parameters, persistent evidence, untouched defaults, and visible rerouting with no corrective turn. Native smoke assertions add saved model selection, unsupported Astra rejection, managed-only enforcement, follow-up, and reload recovery. Local native execution stopped before host startup because installed VS Code's `vscode-updating` mutex remained held after 31 seconds; PR #23 subsequently passed Linux and [Windows native acceptance](https://github.com/ndunl075/hydra/actions/runs/35288175795) at `ca0cc6d`. No authenticated provider turns or credential reads were performed for this feature. See the [combined acceptance record](Implementation_Status.md#acceptance-record) for the final installer revision.

Remaining work includes full revision acceptance of the Claude candidate, authenticated provider acceptance, live quota acceptance, and measured efficiency benchmarks. Local budgets and account setup are separate milestones.

The actual built ModelControls UI passed browser verification against fixture metadata: the exact advertised Astra High selection was saved, unavailable Astra was disabled, and launched task settings were locked. Dark and light rendering passed with the native webview CSP and no browser errors. This verifies UI behavior with fixture choices; it does not establish that a live account advertises Astra.

After merging the scheduler/context/integration stack, type checking, the build, and all 75 dynamically discovered regression tests passed on Windows. The combined code preserves durable context locking before enqueue, exact schedule-intent identity checks, cancellation after startup persistence before process spawn, model validation before turn submission, and the fifth native smoke task's model-setting recovery assertions.
