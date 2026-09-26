---
name: ui-check
description: Start the project's dev server, check a page at three widths, keyboard use, labels/contrast and a clean console, and read Hydra's screenshots gate report.
---

# UI check

A checklist for verifying a frontend change actually works, not just that it compiles.

## 1. Get the dev server running

- Look for an existing dev server first — check the project's `package.json` scripts (`dev`, `start`, `serve`) or a README/CONTRIBUTING note. If one is already running (check a likely port), reuse it rather than starting a second instance.
- Otherwise start the project's own dev command. Note the URL and port it prints.
- Stop any server you started yourself once you're done checking — don't leave background processes behind.

## 2. Check the page at three widths

Check the changed page or component at **390px** (phone), **768px** (tablet) and **1280px** (desktop) wide.

- **With the Playwright MCP tools**, if your role has them: navigate to the page, resize the viewport to each width in turn, and take a screenshot at each. Look at the screenshot for wrapping, overlap, clipped text and broken layout.
- **Without Playwright tools** you can't see the page. Read the markup and styles for each width's breakpoints instead, and say plainly in your report that you didn't check it in a browser.

At every width, check that: nothing overlaps or clips, text wraps instead of overflowing, and any newly-added controls stay reachable and readable.

## 3. Keyboard use

- Tab through the page from the top. Every interactive control (links, buttons, inputs, custom widgets) should be reachable in a sane order.
- Confirm a visible focus indicator on each stop — don't rely on browser defaults alone if the project's CSS suppresses them.
- Try the primary action (submit, open, toggle) using only the keyboard (Enter/Space), not a mouse click.

## 4. Labels and contrast

- Every input has a visible label or an accessible name (`aria-label`/`aria-labelledby`) — not just a placeholder.
- Check text contrast against its background, especially for muted or secondary text, disabled states, and anything on a colored background.

## 5. Console

- Open the browser devtools console while exercising the change.
- It should be clean: no new errors, and no new warnings that weren't there before your change.

## 6. Reading Hydra's screenshots gate

If the project has a screenshots gate, Hydra runs it on your work before it is accepted or merged: it starts the app on a free port, captures the configured pages at their widths, and fails when the app never gets ready, a page answers with an HTTP error, throws or logs to console.error, or renders an empty body. When it fails, Hydra's message lists the problems, and the screenshots it took are its evidence. Fix the cause and check that page again yourself. The gate is evidence for your reviewer, not a replacement for your own look at the page.
