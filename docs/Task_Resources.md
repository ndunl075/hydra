# Task resources and explicit setup

> **Removed (2026-09-24).** This described part of Hydra's managed-task system, which was removed once the Agents view became a live canvas of Hydra heads (see [Agents_View_Plan.md](Agents_View_Plan.md), "As built", and [Heads.md](Heads.md)). Kept for history; none of it is in the product any more.

Shared managed/terminal/setup reservations are a separate 0.18.0 candidate; see [Profile_Capacity.md](Profile_Capacity.md).

Open **Resources and setup** in a task before its first provider launch. Save an optional port (1024–65535), database identifier, service identifier, and up to ten commands as JSON records with `executable` and literal `args`. Choose a 1–600 second timeout per command. An empty command array assigns resources without running setup.

Hydra reserves each assignment across windows using the same local Hydra profile. Reservations survive restart and remain until explicitly released. A conflicting Hydra task cannot acquire the same port or identifier. New port assignments also check whether `127.0.0.1` can bind that port at assignment time. Hydra closes that test socket immediately: another application can occupy it later. Different profiles and machines do not share this reservation store.

Database and service identifiers are names, not automatically provisioned databases, containers or operating-system services. Your explicit commands must create the backing resources and configure the application to use them. Hydra does not copy another task's environment file or install dependencies automatically.

Saved assignments reach both setup and Hydra-owned managed/terminal provider launches:

| Assignment | Environment variable |
| --- | --- |
| Port | `HYDRA_TASK_PORT` |
| Database | `HYDRA_TASK_DATABASE` |
| Service | `HYDRA_TASK_SERVICE` |

Command arguments can contain `{{HYDRA_TASK_PORT}}`, `{{HYDRA_TASK_DATABASE}}` and `{{HYDRA_TASK_SERVICE}}`. Hydra substitutes only assigned values before launching any command; a missing assignment rejects setup. Executables are not expanded. Commands are executable/argument records rather than shell command strings; use an actual executable for complex arguments on Windows.

For example, select a task-specific database and run your project's setup script:

```json
[
  { "executable": "node", "args": ["scripts/setup.cjs", "{{HYDRA_TASK_DATABASE}}"] }
]
```

**Run saved setup** is an explicit action that may change files or create resources. Commands run sequentially in the verified task checkout with saved assignments. If dependencies specify a reviewed starting result, Hydra prepares that checkout first and records its actual starting commit. Every saved command must exit successfully before provider work can be queued or started. Changing dependencies invalidates previous setup success. Resource assignments lock after first launch; restored tasks can reacquire their existing saved assignments and run setup again.

Setup counts against this window's configured concurrency alongside terminal and managed writers. An active or uncertain setup also prevents review, integration, discard, dependency preparation and overlapping provider work on that task. **Stop setup** waits for termination of the owned process tree. Use bounded foreground commands: Hydra does not sandbox user-selected setup commands or provide ownership guarantees for processes that detach, escape their process group or outlive an already-exited parent with redirected pipes.

Diagnostics retain cwd, assignments, commands, exit status and bounded output in workspace-private setup logs. Total captured output is limited to 1 MiB per setup run; the task snapshot contains at most 16,000 characters per output stream per command. Output overflow or timeout fails setup. Commands should avoid printing secrets; logs contain their output.

After a restart during setup, Hydra marks its writer uncertain and holds capacity. Stop surviving setup processes yourself, then select **I stopped setup** and confirm the native dialog. This acknowledgement releases the uncertain writer slot; successful setup is still required before launching. Hydra never automatically reruns setup or steals another task's reservation.

**Release reservations** frees Hydra's logical claims only. It does not drop a database, stop a service, remove files or destroy a container. After launch, discard the stopped task before releasing; its checkout remains recoverable. Restore it, then **Reacquire saved resources** and rerun setup as needed. Configured resource tasks currently use Hydra managed sessions or provider terminals; official-extension handoff is blocked because Hydra cannot verify that client's environment.

This feature is a foundation for explicit resource separation. It does not establish full environment isolation, automatic service provisioning, real-provider acceptance or measured efficiency savings.
