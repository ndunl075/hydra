---
name: test-first
description: Write a failing test first, make it pass with the smallest change, then tidy up.
---

# Test first

Use this whenever you're adding new behavior, not just when a task explicitly says "TDD." It keeps you honest about what "done" means and gives the reviewer something concrete to point at.

## The loop

1. **Write a failing test.** Before touching the implementation, write a test that describes the behavior you're about to add. Run it and confirm it actually fails — for the reason you expect, not because of a typo or a missing import.
2. **Make it pass.** Write the smallest change that makes the test go green. Resist the urge to build out the whole feature in one leap; get the one case working first.
3. **Tidy up.** With the test passing, clean up: remove duplication, rename anything unclear, simplify conditionals. Re-run the tests after each small edit. If anything goes red, undo the last edit rather than debugging forward.
4. **Repeat** for the next case (edge cases, error paths, boundary values) until the brief's behavior is covered.

## Picking the test level

- Prefer the smallest test that would catch a real regression: a unit test for pure logic, an integration test when the value is in how pieces connect.
- Match the project's existing test style and file layout — look at a neighboring test file before writing a new one from scratch.
- Don't test framework internals or the language itself; test your own logic and its edge cases.

## Before you report done

- Run the full project test command (not just the file you touched) so you catch anything you broke elsewhere.
- If a test is slow, flaky, or hard to write for a legitimate reason, say so in your summary instead of quietly skipping it.
- Leave the test suite green. A red suite is not a stopping point — either fix it or explain clearly why you could not.
