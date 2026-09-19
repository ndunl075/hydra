# Normal-turn planner ingestion

Feature 03 records one explicit Solo or delegate decision from a parent's existing managed turn. It does not make a planner request, create a worktree or child task, enqueue a scheduler request, or launch a provider.

Before the normal turn starts, Hydra persists a host-built planner receipt with a new run ID, parent/base/provider/model facts, policy, and the saved Auto/Solo preference. The provider receives a visible suffix requesting one final `HYDRA_DELEGATION_V1:` line followed by compact proposal JSON. Ordinary prose and unmarked JSON are never interpreted as a plan.

The managed adapter persists the normal turn and then calls an awaited prepared observer before provider submission. Hydra binds that actual turn ID to the planner receipt. On a successful completed turn, the completion observer accepts only the exact bound ID, runs the existing proposal and host validators, and records through `DelegationStore`. A valid duplicate completion is already terminal; it cannot produce a second decision.

Accepted and validator-rejected receipts are durable task state. If the decision store succeeds but the task-store save is interrupted, restart reloads the same completed turn and retries the same receipt; no new provider turn or run ID is created. Interrupted and failed turns are not ingested.
