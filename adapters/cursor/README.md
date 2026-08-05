# pear for Cursor

Copy `adapters/cursor/hooks.json` into your project `.cursor/hooks.json` (schema version 1), adjusting hook command paths.

`preToolUse` and `beforeShellExecution` gate mutating tools at DEFAULTS pause lines/edits. Over budget → deny with bundled navigator findings in `user_message` and conversational block in `agent_message` (`failClosed: false`).

`sessionStart` spawns the background navigator daemon for git repos; `sessionEnd` stops it. Checkpoint state persists in `.pear/checkpoint.json`.

Requires Node >= 22.19 with `--experimental-strip-types`.

`sessionStart` also nudges once, via `systemMessage`, when no navigator model is configured yet: run `node --experimental-strip-types /path/to/pear/adapters/shared/setup.ts` (from your pear checkout) to pick one, or `npm run setup` from that checkout. The choice is saved to `~/.pear/config.json` (global default; a repo can override it by hand-editing `.pear/config.json` there) and used by the daemon on every subsequent `sessionStart`.
