# pear

A lean pair-programming CLI for working with coding agents.

Pear gives you two complementary roles:

- **Driver** — takes a task and makes changes, pausing at checkpoints so you stay in control.
- **Navigator** — watches uncommitted Git changes and asynchronously reviews them for findings.

You can ask the driver to work on a task, edit files yourself, or do both. Navigator reviews appear as changes settle.

## Requirements

- Node.js 22.19.0 or later
- A configured AI provider supported by the bundled `pi` libraries
- Git, if you want navigator reviews

## Install

From this repository:

```sh
npm install
```

Run Pear directly:

```sh
./bin/pear
```

Or install/link it with npm to use `pear` as a command:

```sh
npm link
pear
```

## Usage

Start Pear in the current project:

```sh
pear
```

Or point it at another directory:

```sh
pear path/to/project
```

At the prompt, describe the task you want the driver to perform. Pear streams its progress and pauses before enough mutations or new lines accumulate, giving you a chance to continue or redirect it.

In a Git repository, Pear also reviews uncommitted work after a short quiet period. This applies to changes you make yourself as well as driver changes. Outside a Git repository, navigator review is disabled and checkpoints use mutation count only.

### In-session commands

- `/status` — show the current session status
- `/quit` — leave Pear

## Configuration

Useful options:

```sh
pear . \
  --drive-model provider/model \
  --nav-model provider/model \
  --pause-lines 150 \
  --pause-edits 5 \
  --min-lines 50 \
  --debounce 10 \
  --interval 60
```

- `--drive-model <provider/id>` — model used to implement tasks
- `--nav-model <provider/id>` — model used to review changes
- `--pause-lines <n>` — pause the driver after this many new lines
- `--pause-edits <n>` — pause the driver after this many mutations
- `--min-lines <n>` — minimum changed lines before navigator review
- `--debounce <seconds>` — wait for edits to settle before reviewing
- `--interval <seconds>` — minimum time between navigator reviews
- `--no-nav` — turn off navigator review

Use `pear --help` for the current defaults and complete option reference.

## Development

```sh
npm test
npm run typecheck
```

For project architecture and contribution guidance, see [AGENTS.md](AGENTS.md).
