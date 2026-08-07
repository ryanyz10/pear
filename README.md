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

## Install (Claude Code)

From this repository:

```sh
claude plugin marketplace add "$(git rev-parse --show-toplevel)"
claude plugin install pear-claude-code@pear
```

Restart Claude Code (or run `/reload-plugins`) to activate it. No in-chat commands — Claude Code has no command surface, so configure via `.pear/config.json` (see [Configuration](#configuration) below). Details: [adapters/claude-code/README.md](adapters/claude-code/README.md).

## Install (Cursor)

Copy `adapters/cursor/hooks.json` into your project's `.cursor/hooks.json` (schema version 1), adjusting the hook command paths to point at this checkout. Requires Node >= 22.19 with `--experimental-strip-types` on `PATH`.

No in-chat commands — configure via `.pear/config.json` (see [Configuration](#configuration) below). Details: [adapters/cursor/README.md](adapters/cursor/README.md).

## Install (OpenCode)

OpenCode auto-loads local plugin files from `.opencode/plugins/*.ts` in your project — no `plugin` array entry needed for local files; that array resolves npm packages (or explicit `file://` URLs), and a bare `"pear"` entry would fail to resolve a local symlink. Symlink this checkout's `index.ts` in instead:

```sh
mkdir -p .opencode/plugins
ln -s /path/to/pear/adapters/opencode/index.ts .opencode/plugins/pear.ts
```

Then merge just the `permission` block from `adapters/opencode/opencode.json` into your project's `opencode.json`, so `write`/`edit`/`bash` use `ask` permission:

```json
{ "permission": { "edit": "ask", "bash": "ask" } }
```

Restart OpenCode and check its logs to confirm the plugin loaded before relying on it.

No in-chat commands — configure via `.pear/config.json` (see [Configuration](#configuration) below). `human-driver` review is a stub for OpenCode (no real model call yet). Details: [adapters/opencode/README.md](adapters/opencode/README.md).

## Configuration

`.pear/` holds runtime state for every host — `config.json`, plus `checkpoint.json`/`findings.pending`/`findings.log`/`daemon.pid` where applicable. None of the install steps above add it to git for you; do it once per project:

```sh
echo '.pear/' >> .gitignore
```

Pi and omp read/write `.pear/config.json` in the project root via `/pear-mode` and `/pear-config`. Fields and defaults:

| Field | Default | Applies to |
|---|---|---|
| `mode` | `"off"` | all — `"off" \| "human-driver" \| "agent-driver"` |
| `reviewModel` | `openai/gpt-5.6-terra` | `human-driver` — small/fast model that generates findings |
| `filterModel` | `openai/gpt-5.6-sol` | `human-driver` — larger model that filters those findings |
| `checkpointModel` | `openai/gpt-5.6-terra` | `agent-driver` (pi/omp only) — fast model that judges whether the current diff is a good stopping point; if this default or an explicitly-set model can't be resolved in the registry, falls back to the deterministic cadence below |
| `minLines` | `50` | `human-driver` — min changed lines before a review fires |
| `debounceSeconds` | `10` | `human-driver` — quiet period after the last edit |
| `intervalSeconds` | `60` | `human-driver` — min seconds between reviews |
| `checkpointSeconds` | `300` | `agent-driver` — wall-clock cadence before a forced pause (also the checkpoint judge's hard backstop on pi/omp) |
| `maxChangesPerCheckpoint` | `5` | `agent-driver` — mutating tool calls before pausing (pi/omp: before consulting the checkpoint judge) |

`mode` and the cadence fields are project-scoped only (no global fallback). `reviewModel`/`filterModel`/`checkpointModel` fall back to `~/.pear/config.json` (global), then to the defaults above.

Claude Code and Cursor have no in-chat command surface: they read the same `.pear/config.json` (project) plus `~/.pear/config.json` (global model fallback), and each nudges once with the setup command when nothing is configured. OpenCode reads the same `.pear/config.json`/`~/.pear/config.json` but has no such nudge — edit the file directly or run setup yourself. Run setup **from the target project**, pointing at this checkout by absolute path:

```sh
cd /path/to/your/project
node --experimental-strip-types /path/to/pear/adapters/shared/setup.ts
```

`npm run setup` runs the identical script but only works when your target project *is* this pear checkout — it saves `.pear/config.json` into whatever directory it's run from, so running it from inside the pear checkout configures the checkout itself, not some other project.

## Development

```sh
npm test
npm run typecheck
npm run smoke:pi
npm run smoke:claude
npm run smoke:omp
```

Architecture and contribution guidance: [AGENTS.md](AGENTS.md). Host-specific notes live under `adapters/*/README.md`.
