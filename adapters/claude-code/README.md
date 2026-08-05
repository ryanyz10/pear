# pear for Claude Code

Add this repo as a Claude Code plugin marketplace, then install the plugin:

```sh
claude plugin marketplace add "$(git rev-parse --show-toplevel)"
claude plugin install pear-claude-code@pear
```

Restart Claude Code (or run `/reload-plugins`) to activate it. To pick up a change you make locally, `claude plugin marketplace update pear` then `claude plugin update pear-claude-code@pear`.

The plugin vendors `core/` and `adapters/shared/` into `adapters/claude-code/_vendor/` via symlinks so it installs as a self-contained unit: Claude Code's plugin cache copies only a plugin's own directory, but dereferences and copies symlink targets that live elsewhere in this marketplace rather than skipping them. Don't hand-edit anything under `_vendor/` — it exists only to satisfy that copy step; the real source is `core/` and `adapters/shared/`.

Pear runs in one mode at a time, read from `.pear/config.json` (project) and `~/.pear/config.json` (global model fallback): `off` (default), `agent-driver`, or `human-driver`. Claude Code has no in-chat command surface, so mode/config here is file-only — see the top-level [README](../../README.md#configuration) for fields and defaults.

Hooks gate `Write`/`Edit`/`Bash` only in `agent-driver` mode, at `checkpointSeconds`/`maxChangesPerCheckpoint` via `.pear/checkpoint.json`. Over budget → deny with a conversational checkpoint message. Other modes always allow.

`PostToolUse` settles successful mutating calls; `PostToolUseFailure` settles failed ones the same way, so a failed Edit/Write/Bash doesn't leave a stuck reservation. Both drain `.pear/findings.pending` into `systemMessage`, as does `UserPromptSubmit`.

`SessionStart` spawns the background navigator daemon only in `human-driver` mode (git repos); `SessionEnd` stops it.

`SessionStart` also nudges once, via `systemMessage`, when no mode is configured yet: run `node --experimental-strip-types "$CLAUDE_PLUGIN_ROOT/_vendor/adapters/shared/setup.ts"` to choose `agent-driver` or `human-driver`. The choice is saved to `.pear/config.json` in the project you ran it from.
