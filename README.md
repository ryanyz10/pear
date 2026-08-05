# pear

Pair-programming loop core + host adapters.

Pear runs in exactly one mode at a time, per project:

- **`off`** (default) — no gating, no reviews.
- **`agent-driver`** — you drive; pear gates mutating tool calls with a wall-clock + change-count checkpoint so the agent pauses and explains itself periodically.
- **`human-driver`** — the human drives; pear runs a background navigator that reviews uncommitted changes with a two-stage review (a fast model generates findings, a stronger model filters them) and posts human-only findings.

- **Pi** — full in-chat mode commands + in-process checkpoint/navigator (primary ship)
- **oh-my-pi (`omp`)** — native extension on the same core, using omp's own message/renderer API
- **Opencode / Claude Code / Cursor** — follow-on adapters on the same core (conversational gate / daemon), configured via `.pear/config.json` since these hosts have no in-chat command surface

## Requirements

- Node.js 22.19.0 or later
- [pi](https://github.com/badlogic/pi-mono) for the primary extension
- [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) for the native omp extension
- Git, for `agent-driver`'s checkpoint file-provenance display and for `human-driver` (which requires a git working tree)

## Install (pi)

From this repository:

```sh
npm install
pi install "$(git rev-parse --show-toplevel)"
# or load without installing:
pi -e ./adapters/pi/extensions/pear.ts
```

In-session: `/pear-mode [off|human-driver|agent-driver]`, `/pear-config`, `/pear-status`

## Install (omp)

From this repository:

```sh
npm install
omp plugin link "$(git rev-parse --show-toplevel)" --scope user
# or load without installing:
omp --extension ./adapters/omp/extensions/pear.ts
```

In-session: `/pear-mode [off|human-driver|agent-driver]`, `/pear-config`, `/pear-status`

## Configuration

Pi and omp read/write `.pear/config.json` in the project root (gitignored) via `/pear-mode` and `/pear-config`. Fields and defaults:

| Field | Default | Applies to |
|---|---|---|
| `mode` | `"off"` | all — `"off" \| "human-driver" \| "agent-driver"` |
| `reviewModel` | `openai/gpt-5.6-terra` | `human-driver` — small/fast model that generates findings |
| `filterModel` | `openai/gpt-5.6-sol` | `human-driver` — larger model that filters those findings |
| `minLines` | `50` | `human-driver` — min changed lines before a review fires |
| `debounceSeconds` | `10` | `human-driver` — quiet period after the last edit |
| `intervalSeconds` | `60` | `human-driver` — min seconds between reviews |
| `checkpointSeconds` | `300` | `agent-driver` — wall-clock cadence before a forced pause |
| `maxChangesPerCheckpoint` | `3` | `agent-driver` — mutating tool calls per checkpoint |

`mode` and the cadence fields are project-scoped only (no global fallback). `reviewModel`/`filterModel` fall back to `~/.pear/config.json` (global), then to the defaults above.

Claude Code and Cursor have no in-chat command surface: they read the same `.pear/config.json` plus `~/.pear/config.json`, and `SessionStart` nudges once with the setup command when nothing is configured. Run interactively from a checkout:

```sh
npm run setup
```

## Development

```sh
npm test
npm run typecheck
npm run smoke:pi
npm run smoke:claude
npm run smoke:omp
```

Architecture and contribution guidance: [AGENTS.md](AGENTS.md). Host-specific notes live under `adapters/*/README.md`.
