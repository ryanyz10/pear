# pear for OpenCode

Copy `adapters/opencode/` into your OpenCode plugins directory, or symlink `index.ts` as plugin `pear`.

Merge `opencode.json` into your project config so `write`/`edit`/`bash` use `ask` permission and load the `pear` plugin.

The plugin gates mutating tools at DEFAULTS pause lines/edits (150 lines / 5 mutations). Over budget it throws a conversational checkpoint block; under budget it reserves and allows.

Optional navigator stub polls git state when the project is a repo and appends stub findings to `.pear/findings.log`.
