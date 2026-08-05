# pear

Pair-programming loop core + host adapters.

Pear gates mutating tool calls with human checkpoints and, in Git repos, runs a background **navigator** that reviews uncommitted changes. Findings are human-only by default.

- **Pi** — full modal checkpoints + in-process navigator (primary ship)
- **oh-my-pi (`omp`)** — native extension on the same core, using omp's own message/renderer API
- **Opencode / Claude Code / Cursor** — follow-on adapters on the same core (conversational gate / daemon)

## Requirements

- Node.js 22.19.0 or later
- [pi](https://github.com/badlogic/pi-mono) for the primary extension
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) for the native omp extension
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

In-session: `/pear-status`, `/pear-setup`

## Install (omp)

From this repository:

```sh
npm install
omp plugin link "$(git rev-parse --show-toplevel)" --scope user
# or load without installing:
omp --extension ./adapters/omp/extensions/pear.ts
```

Useful flags (registered by the extension):

```sh
omp --nav-model provider/id --pause-lines 150 --pause-edits 5 --no-nav
```

In-session: `/pear-status`, `/pear-setup`

## Navigator model

On first session in a git repo, pi/omp ask once which model the navigator should use — sourced from your configured models, not a hardcoded list — and save the answer to `~/.pear/config.json` (global), applied across every project and host, including the Claude Code/Cursor daemon. `--nav-model provider/id` always overrides it for that run. Re-run the picker with `/pear-setup` (pi/omp) or, from a checkout:

```sh
npm run setup
```

Claude Code and Cursor have no interactive picker; `SessionStart` nudges once with the exact command to run when nothing is configured. A single project can override the global choice by hand-editing `.pear/config.json` in that repo (gitignored; project config wins over global).

## Development

```sh
npm test
npm run typecheck
npm run smoke:pi
npm run smoke:claude
npm run smoke:omp
```

Architecture and contribution guidance: [AGENTS.md](AGENTS.md). Host-specific notes live under `adapters/*/README.md`.
