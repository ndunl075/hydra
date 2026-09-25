# Shared profile task capacity

> **Removed (2026-09-24).** This described part of Hydra's managed-task system, which was removed once the Agents view became a live canvas of Hydra heads (see [Agents_View_Plan.md](Agents_View_Plan.md), "As built", and [Heads.md](Heads.md)). Kept for history; none of it is in the product any more.

Hydra 0.18.0 is a development candidate. `hydra.maxConcurrentProfileTasks` is an application setting with a default of two and a range of one to eight. The existing `hydra.maxConcurrentTasks` window setting also defaults to two. Both limits apply; the profile setting counts reservations across participating Hydra windows using the same local extension profile storage.

Managed Claude/Codex invocations, Hydra-created provider terminals, and explicit setup commands each reserve one slot before dependency preparation. The queue preserves an exact launch/follow-up while waiting for a shared slot, without preparing the checkout or submitting a prompt. Setup reports full capacity for explicit retry. Slots count live/starting writers and uncertain ownership, not accepted task results.

## Ownership and launch checks

Eight fixed slot files are created exclusively and durably written before a launch. A slot records the workspace/task identity, per-host UUID, random ownership token, kind and creation time. No credential, prompt, session ID, account identity or transcript is stored. The manager view exposes total reserved slots and only this workspace's task/kind/uncertainty; foreign task IDs and ownership tokens remain outside the UI.

The existing canonical repository locks prevent two windows from owning/reconciling the same repository. Different repositories share this profile pool. Local operations are serialized; duplicate releases cannot delete a later cooperative claimant. Release verifies the recorded token. Missing, replaced, malformed, oversized or symlinked records prevent launch and retain diagnostics/data. There is no PID/age/expiry reclamation. An invalid unowned record needs explicit storage inspection; Hydra does not offer a delete-all control.

The owned reservation is rechecked asynchronously after provider metadata/settings acknowledgement, immediately before a model turn. Stop, loss of trust, closing, configuration changes and launch identity are rechecked after that await. Terminals/setup recheck before creation. Reducing the limit prevents new starts while older reservations remain; active turns continue. The pool is cooperative and does not defend against arbitrary external filesystem replacement during a release or a differently configured older client.

File notifications refresh local slot status and wake queued work. This makes no provider/model request. Waiting reasons are persisted only when changed, avoiding a persist/drain loop. Watcher errors are visible and explicit Refresh rechecks storage.

## Recovery

Successful process completion and metadata persistence release a verified owned slot. Cancellation before launch releases startup protection. A failed start/save cannot prepare or submit a turn. Failure to verify process-tree cleanup sets a durable managed `writerUncertain` flag and holds its slot. Setup retains its existing uncertain writer record.

Restarted hosts retain prior-host reservations as uncertain, including a crash between reservation creation and the `starting` save. Age or an apparently absent PID never releases them. Stop any surviving provider/setup processes and children yourself, then choose **Acknowledge all task writers stopped** and confirm the native dialog. Hydra refuses reconciliation while it owns an active writer or preparation. It durably clears the owned setup/session/schedule uncertainty and retained launch intent before releasing that task's reservation. Queue a new launch/follow-up explicitly afterward. A replaced record belonging to another workspace is preserved.

Shutdown waits for queue preparation and owned managed/setup cleanup before releasing repository locks. Terminals remain conservative uncertain reservations because editor disposal alone cannot prove absence of surviving descendants.

## Acceptance and limits

Local final typecheck/build/package and all 152 applicable regression tests passed, with one Windows symlink fixture skipped. Four staged native fixture hosts passed after the final shutdown fence, including nine-task recovery, a two-slot profile limit while the window limit is four, normal slot release, and retained terminal uncertainty. Compiled browser recovery dispatch passed in dark and light mode, with no console warnings/errors. This is development 0.18.0 staged over a copied accepted editor baseline, not a full source-built release.

Fixtures exercise separate processes racing for two slots, token/foreign-owner protection, reduced limits, malformed records, restart acknowledgement, watcher wakeup, FIFO waiting without drain spin, cancellation during reservation and starting-save failure. Both provider adapters exercise asynchronous final guards and durable cleanup failure. Native tests cover profile slots independently of the window limit, normal completion/release, and retained terminal recovery without submitting a prompt. Linux additionally covers symlink refusal; Windows skips that fixture because creating symlinks can require privileges.

This is a reservation limit for cooperating Hydra hosts using the same filesystem/profile. It does not impose an OS process limit, spend cap, provider quota, or protection from official extensions/clients, earlier Hydra versions, other profiles/machines, escaped descendants or nested provider workers. Adaptive delegation remains separately planned and must count its managed parent/children when implemented. Full revision Linux/Windows CI, real-provider acceptance and manual recovery/accessibility are separate gates.
