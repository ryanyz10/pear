# pear

Pair-programming loop core + host adapters.

Pear gates mutating tool calls with human checkpoints and, in Git repos, runs a background **navigator** that reviews uncommitted changes. Findings are human-only by default.

- **Pi** — full modal checkpoints + in-process navigator (primary ship)
- **Opencode / Claude Code / Cursor** — follow-on adapters on the same core (conversational gate / daemon)

## Requirements

- Node.js 22.19.0 or later
- [pi](https://github.com/badlogic/pi-mono) for the primary extension
- Git, if you want navigator reviews

## Install (pi)

From this repository:

```sh
npm install
pi install "$(git rev-parse --show-toplevel)"
# or load without installing:
pi -e ./adapters/pi/extensions/pear.ts
```

Useful flags (registered by the extension):

```sh
pi --nav-model provider/id --pause-lines 150 --pause-edits 5 --no-nav
```

In-session: `/pear-status`

## Development

```sh
npm test
npm run typecheck
npm run smoke:pi
```

Architecture and contribution guidance: [AGENTS.md](AGENTS.md). Host-specific notes live under `adapters/*/README.md`.
