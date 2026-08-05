# pear for Cursor

Copy `adapters/cursor/hooks.json` into your project `.cursor/hooks.json` (schema version 1), adjusting hook command paths.

Pear runs in one mode at a time, read from `.pear/config.json` (project) and `~/.pear/config.json` (global model fallback): `off` (default), `agent-driver`, or `human-driver`. Cursor has no in-chat command surface, so mode/config here is file-only — see the top-level [README](../../README.md#configuration) for fields and defaults.

`preToolUse` and `beforeShellExecution` gate mutating tools only in `agent-driver` mode, at `checkpointSeconds`/`maxChangesPerCheckpoint`. Over budget → deny with bundled navigator findings in `user_message` and conversational block in `agent_message` (`failClosed: false`). Other modes always allow.

`sessionStart` spawns the background navigator daemon only in `human-driver` mode for git repos; `sessionEnd` stops it. Checkpoint state persists in `.pear/checkpoint.json`.

Requires Node >= 22.19 with `--experimental-strip-types`.

`sessionStart` also nudges once, via `systemMessage`, when no mode is configured yet: run `node --experimental-strip-types /path/to/pear/adapters/shared/setup.ts` (from your pear checkout) to choose `agent-driver` or `human-driver`, or `npm run setup` from that checkout. The choice is saved to `.pear/config.json` in the project you ran it from.
