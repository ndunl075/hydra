# Hydra Context Engine / Clean MCP Notes

> Status: exploratory. This is a potential future direction, not a committed implementation.

## Why this matters

Hydra already focuses on coordinating multiple coding agents across isolated tasks and worktrees. A natural next step is helping those agents consume less context while still finding the code they need.

A local semantic code-intelligence layer could reduce repeated repository scans, large file reads, and unnecessary token usage across Claude Code, Codex, and future providers.

## Clean MCP as a reference

Clean MCP is an open-source project focused on reducing token usage for coding agents through local code indexing and retrieval.

Relevant ideas include:

- Local-only repository indexing.
- Tree-sitter-based code parsing.
- Semantic code search.
- Symbol and call-graph awareness.
- Local embeddings.
- Incremental indexing.
- Small initial retrieval results that can be expanded on demand.
- MCP tools for code search and source retrieval.

Hydra should treat Clean MCP primarily as a reference implementation and optional integration rather than immediately bundling the project wholesale.

Directly embedding it would introduce additional runtime and dependency requirements, including Python and local embedding infrastructure. Hydra should avoid taking on those dependencies until the value and architecture are proven.

## Potential Hydra architecture

```text
Hydra Core
├── Agent orchestration
├── Worktree manager
├── Resource manager
├── Event bus
├── Code intelligence
│   ├── Repository index
│   ├── Semantic search
│   ├── Symbol graph
│   ├── Call graph
│   ├── Context retrieval
│   └── Token-aware expansion
├── Local API
├── MCP server
└── Hydra IDE
```

The code-intelligence layer should eventually be shared by all Hydra-managed agents instead of requiring each agent to rediscover the same repository structure independently.

## Potential capabilities

Hydra could expose tools such as:

```text
hydra.search_code
hydra.get_symbol
hydra.get_related_code
hydra.get_changes_since_task_start
hydra.expand_context
hydra.build_task_context
```

This would let agents request narrow, relevant context instead of reading large portions of a repository.

## Task context packages

A higher-value Hydra-native feature would be automatic context packaging.

When Hydra delegates a task, it could assemble a compact starting context containing:

- Relevant files and symbols.
- Nearby call paths.
- Interfaces used by the target code.
- Related recent changes.
- Dependencies on other Hydra tasks.
- Existing task notes or decisions.
- Repository-specific instructions.

The package should remain small and expandable rather than attempting to preload the entire repository.

This could substantially reduce duplicate discovery work when many agents operate in parallel.

## Suggested progression

### Phase 1 — Optional Clean MCP integration

Allow Hydra users or agents to connect an existing Clean MCP instance as an external MCP server.

Use this to validate whether semantic retrieval materially improves Hydra workflows and token usage.

### Phase 2 — Hydra-native context engine

Implement the most valuable concepts directly inside Hydra Core:

- Repository indexing.
- Symbol extraction.
- Semantic retrieval.
- Incremental updates.
- Worktree-aware indexes.
- Token-aware result sizing.

The implementation does not need to duplicate Clean MCP exactly.

### Phase 3 — Automatic agent context

Use the context engine during orchestration.

Before an agent begins a delegated task, Hydra can provide a compact, relevant context package automatically.

Hydra could then continue expanding context only when the agent asks for it.

## Relationship to the Hydra API and MCP server

The context engine and the orchestration API solve different problems.

The **Hydra API** provides programmatic access to Hydra's orchestration state and controls.

The **Hydra MCP server** lets AI agents use those orchestration capabilities as tools.

The **context engine** helps those agents find and consume relevant code efficiently.

Example:

```text
Agent
  │
  ├── asks Hydra MCP: "What task am I working on?"
  ├── asks Hydra MCP: "Has the backend dependency finished?"
  ├── asks Hydra MCP: "Find the auth validation code."
  │
  ▼
Hydra Core
  ├── Orchestration state
  ├── Task dependencies
  ├── Worktree ownership
  └── Context engine
```

The API/MCP layer is therefore infrastructure that other agents and tools can use to communicate with Hydra. The context engine is one capability that can later be exposed through that infrastructure.

## Important sequencing note

The API and MCP server do **not** need to be the first feature Hydra builds.

The likely prerequisite is a clean internal Hydra Core boundary.

Hydra should first make sure task state, agent state, worktree ownership, resource reservations, events, and other orchestration logic can be accessed through stable internal interfaces.

Once that internal boundary exists, the same capabilities can be exposed through:

1. the Hydra IDE,
2. a local API,
3. an MCP server,
4. and eventually trusted Hydra-to-Hydra communication.

This prevents the public interface from being designed around unstable internal implementation details.

## Design principle

Hydra's advantage should not be that it simply exposes another provider API or another code-search service.

Its value is combining:

- agent orchestration,
- isolated parallel work,
- shared task state,
- dependencies,
- resource coordination,
- review state,
- communication,
- and eventually efficient context retrieval.

The long-term goal is:

**many agents, many workspaces, minimal duplicated context, one coordination layer.**
