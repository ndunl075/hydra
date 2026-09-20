# Potential Hydra API Plan

> Status: exploratory. This document describes a possible future direction, not a committed implementation.

## Goal

Turn Hydra from an IDE that manages AI coding agents into a reusable orchestration layer that other workspaces, tools, and agents can communicate with.

The API should let Hydra coordinate work across multiple agents and workspaces while keeping task ownership, isolation, review, and security centralized.

## Core idea

Hydra Core would own orchestration state and expose it through multiple interfaces:

```text
Hydra Core
├── Task / agent orchestration
├── Worktree + resource manager
├── Event bus
├── Local API
│   ├── HTTP
│   └── WebSocket
├── MCP server
└── Hydra IDE
```

The IDE becomes one client of Hydra Core rather than the only way to interact with it.

## Potential capabilities

External clients could:

- Create, inspect, update, and cancel tasks.
- Assign tasks to Claude Code, Codex, or future providers.
- Query agent state, task state, dependencies, and ownership.
- Send follow-up instructions to managed agents.
- Inspect worktree, branch, diff, and review state.
- Reserve ports, databases, services, and other shared resources.
- Coordinate dependencies between agents working in parallel.
- Exchange structured messages between tasks or agents.
- Subscribe to events such as `task.started`, `agent.waiting`, `approval.required`, and `task.completed`.
- Discover other Hydra-managed workspaces and agents when explicitly permitted.

## MCP interface

Hydra should strongly consider exposing the same orchestration layer through MCP.

This would let an AI agent directly ask Hydra questions such as:

- What other agents are working on this repository?
- Has the backend task finished?
- What files did another task change?
- Create an isolated task for these failing tests.
- Tell the frontend task that the API contract changed.
- What tasks are currently blocked on my work?

MCP could make Hydra itself available as a tool to Claude Code, Codex, and other compatible agents without requiring provider-specific integrations.

## Cross-workspace coordination

A future Hydra API could allow trusted Hydra workspaces to communicate with each other.

Possible uses:

- One workspace depends on a task running in another repository.
- A backend agent publishes an API-contract change that a frontend agent consumes.
- A parent task delegates work into separate repositories.
- Multiple Hydra windows share task state without competing for ownership.
- An agent can discover whether related work is already being handled elsewhere.

This should be explicit and permissioned rather than automatic.

## Event model

A lightweight event bus would make coordination reactive instead of requiring clients to constantly poll Hydra.

Example events:

```text
workspace.connected
workspace.disconnected

task.created
task.started
task.updated
task.blocked
task.completed
task.failed

agent.started
agent.waiting
agent.stopped

approval.required
approval.resolved

resource.reserved
resource.released

review.ready
review.accepted
```

Events should carry stable workspace, task, agent, and repository identifiers.

## API shape

Initial implementation should remain local-first.

Possible interfaces:

### HTTP

Useful for commands and state queries.

```text
GET    /v1/workspaces
GET    /v1/tasks
POST   /v1/tasks
GET    /v1/tasks/:id
POST   /v1/tasks/:id/messages
POST   /v1/tasks/:id/stop
GET    /v1/tasks/:id/changes
GET    /v1/agents
GET    /v1/resources
```

### WebSocket

Useful for:

- Streaming task and agent state.
- Provider output.
- Approval requests.
- Cross-agent messages.
- Event subscriptions.

### MCP

Expose higher-level orchestration tools rather than mirroring every HTTP endpoint directly.

Example tools:

```text
hydra.list_tasks
hydra.get_task
hydra.create_task
hydra.send_message
hydra.get_changes
hydra.list_agents
hydra.get_dependencies
hydra.delegate_task
```

## Security model

The API should be localhost-only by default.

Important boundaries:

- Bind to `127.0.0.1` unless remote access is explicitly enabled.
- Require authentication even for local API clients.
- Scope permissions by workspace and capability.
- Do not expose provider credentials or private provider history.
- Do not allow an external client to silently gain write access to every repository.
- Preserve Hydra's existing writer ownership and concurrency protections.
- Require explicit approval before allowing communication with another machine.
- Keep an audit trail of external commands that mutate Hydra state.

Possible permission scopes:

```text
workspace:read
task:read
task:create
task:write
agent:message
changes:read
resources:read
resources:write
review:read
review:write
```

## Suggested implementation order

1. Separate orchestration logic from IDE-specific UI code behind a stable internal Hydra Core interface.
2. Add an internal event bus with stable IDs and typed events.
3. Expose read-only localhost HTTP endpoints.
4. Add authenticated task creation and control endpoints.
5. Add WebSocket event streaming.
6. Add an MCP server backed by the same Hydra Core interface.
7. Add scoped cross-workspace communication on the same machine.
8. Only then consider trusted LAN or remote Hydra-to-Hydra communication.

## Design principle

Hydra should not become another thin wrapper around provider APIs.

Its value is the coordination layer: isolated work, ownership, scheduling, dependencies, resources, review state, and communication between many independent coding agents.

The long-term model is:

**many agents, many workspaces, one orchestration layer.**
