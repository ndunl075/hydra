# Task setup recipes

A setup recipe is a review-only, reproducible description of one task's expected setup. It does not reserve a port, provision a database or service, start a process, read the checkout, or write a file. Existing **Resources and setup** execution remains responsible for those actions.

Each version 1 recipe contains a 12-hex task ID, a normalized absolute workspace path, optional port/database/service names, a list of environment variable **names**, ordered executable-and-argument records, and a one-to-600 second timeout that applies to each command. Environment values are not accepted. Command arguments remain in the local source recipe but are never copied into its preview because they may contain secrets.

For example:

```json
{
  "version": 1,
  "taskId": "123456789abc",
  "workspacePath": "C:\\worktrees\\recipe-task",
  "port": 4312,
  "database": "recipe_task",
  "service": "recipe_service",
  "environment": ["NODE_ENV"],
  "commands": [
    { "executable": "node", "args": ["scripts/setup.cjs", "{{HYDRA_TASK_DATABASE}}"] },
    { "executable": "npm.cmd", "args": ["run", "prepare"] }
  ],
  "timeoutMs": 120000
}
```

Validation refuses unknown fields, values in environment entries, duplicate environment names, names that collide with Hydra's `HYDRA_TASK_*` assignments, a database and service with the same name, invalid resource identifiers, unsafe command records, invalid timeout, and relative, root, or non-normalized workspace paths. The preview lists reservation names and their Hydra assignment names, environment names, command order, argument counts, timeout, and a SHA-256 digest of the canonical recipe. It omits environment values and command arguments.

The digest identifies exactly what was reviewed; changing a path, resource, environment name, command, argument, or timeout produces a new digest. A valid recipe remains advisory until the user selects the existing setup execution flow described in [Task_Resources.md](Task_Resources.md).
