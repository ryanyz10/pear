# pear for Claude Code

Install the plugin from `adapters/claude-code/` (contains `.claude-plugin/plugin.json`).

Merge `hooks/hooks.json` into your project's Claude Code hooks config, adjusting paths if needed.

Hooks gate `Write`/`Edit`/`Bash` at DEFAULTS pause lines/edits via `.pear/checkpoint.json`. Over budget → deny with a conversational checkpoint message.

`SessionStart` spawns the background navigator daemon (git repos); `SessionEnd` stops it. `PostToolUse` and `UserPromptSubmit` drain `.pear/findings.pending` into `systemMessage`.

Run hooks with `node --experimental-strip-types` (Node >= 22.19).
