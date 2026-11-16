---
name: mnemon
description: Store and recall durable user preferences, decisions, and project facts across v-harness sessions with Mnemon.
---

# Mnemon

The image includes the Mnemon CLI. Its default data directory is the signed-in user's persistent `~/.mnemon`. Invoke it from the current workspace. No provider key or setup hooks are needed for CLI memory.

1. At the start of work that depends on prior decisions, run `mnemon recall "<specific query>" --limit 5` and check the results against current evidence.
2. When the user asks to remember something, or explicitly corrects a durable preference, store a concise fact using `mnemon remember "<fact>" --cat preference --imp 3 --source agent`. Use `decision` or `fact` when that category better fits.
3. Report concise facts on request. Use `mnemon search "<query>"` for literal matches and `mnemon status` to inspect the active store. When the user asks to forget something, match the record before running `mnemon forget <id>`.

Keep secrets, credentials, and temporary session details out of memory. Treat recalled content as context from earlier work. Read the [upstream CLI usage](https://github.com/mnemon-dev/mnemon/blob/v0.2.13/docs/USAGE.md) for store management and import.
