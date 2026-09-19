# Delegation approval-pause graph handoffs

A delegated managed task now records an opaque approval-pause source after its schedule enters `waiting-for-approval`. The task save happens before the graph append. The source contains only parent/run/task/dispatch identity, a deterministic record ID, and the first observed timestamp; it excludes the provider request, tool input, approval detail, prompt, and transcript.

The graph producer emits `host → child task` only from that saved source. If the graph append fails, the task record remains and startup or a later save replays the exact timestamp and record ID. Duplicate observation is a no-op. A person approving a delegated request waits for the pause source to save before the response is sent. Navigation does not create a pause or provider request.

This records the host's observed approval wait, not the eventual approval decision. Provider-native sessions outside Hydra's managed approval surface remain unavailable to this graph contract.
