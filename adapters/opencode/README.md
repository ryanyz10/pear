# pear for OpenCode

Copy `adapters/opencode/` into your OpenCode plugins directory, or symlink `index.ts` as plugin `pear`.

Merge `opencode.json` into your project config so `write`/`edit`/`bash` use `ask` permission and load the `pear` plugin.

Pear runs in one mode at a time, read from `.pear/config.json` (project) and `~/.pear/config.json` (global model fallback): `off` (default), `agent-driver`, or `human-driver`. OpenCode has no in-chat command surface, so mode/config here is file-only — see the top-level [README](../../README.md#configuration) for fields and defaults.

In `agent-driver` mode the plugin gates mutating tools at `checkpointSeconds`/`maxChangesPerCheckpoint`. Over budget it throws a conversational checkpoint block; under budget it reserves and allows. In `human-driver` mode (git repos only) it polls git state and appends stub navigator findings to `.pear/findings.log` — this remains a stub, matching OpenCode's pre-existing review integration; it does not make a real model call. `off` mode does neither.
