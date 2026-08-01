# pear for Cursor

Copy `adapters/cursor/hooks.json` into your project `.cursor/hooks.json` (schema version 1), adjusting hook command paths.

`preToolUse` and `beforeShellExecution` gate mutating tools at DEFAULTS pause lines/edits. Over budget → deny with bundled navigator findings in `user_message` and conversational block in `agent_message` (`failClosed: false`).

`sessionStart` spawns the background navigator daemon for git repos; `sessionEnd` stops it. Checkpoint state persists in `.pear/checkpoint.json`.

Requires Node >= 22.19 with `--experimental-strip-types`.
