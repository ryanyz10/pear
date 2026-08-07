# pear

A pair-programming loop for [pi](https://github.com/badlogic/pi-mono). The agent
drives; you navigate. After each logical change it stops, tells you what it did
and why, shows you which files moved, and asks what to do next:

```
──────────────────────────────────────────────
 pear checkpoint

 Session tokens weren't cleared on logout, so a reused browser session
 could resurrect an old identity. Cleared the store in logout() and
 added a test for the reuse case.

 changed since last checkpoint (git, best-effort) — 2
   src/auth.ts
   test/auth.test.ts

 next: audit the refresh path for the same bug

 > 1. Continue        looks good, keep going
   2. Make changes…   tell them what to do instead
   3. Stop            I'm taking over

 ↑↓ move · Enter choose · Esc dismiss (pauses changes)
──────────────────────────────────────────────
```

That is the whole idea: the agent works in small, reviewable steps instead of
disappearing for twenty tool calls and handing you a diff you have to reverse
engineer.

## Install

```sh
pi install /path/to/pear
# or, without installing:
pi -e /path/to/pear/adapters/pi/extensions/pear.ts
```

Then turn it on in your project:

```
/pear-mode agent-driver
```

Requires Node >= 22.19 (`.tool-versions` pins the version used here).

## Modes

| Mode | Behaviour |
| --- | --- |
| `off` (default) | pear does nothing |
| `agent-driver` | The agent checkpoints after each logical change |

Mode is per-project, stored in `.pear/config.json`.

> An earlier version also had a `human-driver` mode, where a background
> reviewer critiqued *your* uncommitted changes. It is not in this version. If
> your config still says `human-driver`, pear runs `off`, tells you so, and
> **leaves your config file untouched** so nothing is lost.

## Commands

| Command | What it does |
| --- | --- |
| `/pear-mode [off\|agent-driver]` | Switch mode |
| `/pear-status` | Mode, change budget, and what's outstanding |
| `/pear-checkpoint` | Open a checkpoint yourself, without waiting for the agent |
| `/pear-config [n]` | How many changes may pass between checkpoints (default 5) |

## How the loop is enforced

The agent is *asked* to checkpoint after each logical change, and mostly will.
The prompt is not the enforcement, though — two things back it up:

**A change budget.** Mutating tool calls (`write`, `edit`, and `bash` commands
that aren't provably read-only) are counted. Once `maxChangesPerCheckpoint` is
reached, further mutations are blocked with an explanation telling the agent to
check in first. The blocked call did not run, and the agent is told so, so it
can simply re-issue it afterwards.

**Stop actually stops.** Choosing Stop ends the agent's current work loop and
blocks further changes until you say something. Read-only commands still work,
so you can keep looking around.

Two things are deliberately never blocked: the checkpoint tool itself, and
`/pear-checkpoint`. Whatever state the loop gets into, you can always open a
checkpoint and clear it — which is why an exhausted budget can't wedge the
session.

### Why not checkpoint after literally every edit?

Because a logical change is often three edits and a test run, and interrupting
mid-thought is worse than useless. The agent decides where the seams are; the
budget bounds how wrong it can be about that. Set `/pear-config 1` if you want
one checkpoint per mutation.

## What the file list means

The checkpoint shows a **git-derived** list of what actually changed since the
last checkpoint, next to the files the agent *claims* it touched. If the agent
under-reports, you see it.

That list is labelled best-effort on purpose. It comes from
`git status --porcelain=v2`, including the index object id, so a staged-only
change is visible and a file that changed twice isn't listed twice. Files that
can't be read are reported as changed rather than assumed clean. Outside a git
repo the list is marked unverified and you see only the agent's claim.

Nothing about this list affects the budget — it is there for you to read, and a
wrong file list can never wedge or bypass the loop.

## Interactivity

A checkpoint needs a human, so pear only runs where one can answer:

| pi mode | Checkpoint |
| --- | --- |
| TUI | Full card, inline editor for steering |
| RPC | Select/input dialogs; steering offered only if input is available |
| print / json | pear runs `off` for that session, with a warning |

pear **never** auto-approves a checkpoint. If nobody can answer, it doesn't
pretend one happened.

## Configuration

`.pear/config.json`, per project:

```json
{
  "mode": "agent-driver",
  "maxChangesPerCheckpoint": 5
}
```

- `maxChangesPerCheckpoint` must be a whole number from 1 to 1000.
- Unknown keys are **preserved** across writes, so a newer pear's settings
  survive an older pear touching the file.
- A file that can't be parsed is backed up to `config.json.corrupt-<timestamp>`
  before anything replaces it.
- Writes go to a temp file and are renamed into place, so an interrupted write
  can't truncate your config.
- pear assumes one writer. Two processes editing the config at once is
  last-write-wins, and one may drop the other's fields.

There is no global `~/.pear/config.json`; it only ever held model choices, and
this version makes no model calls at all.

## Development

```sh
npm ci          # exact, pinned installs
npm test
npm run typecheck
npm run smoke:pi
```

Dependencies are pinned exactly (`.npmrc` sets `save-exact=true`) and the API
surface pear relies on is verified against the pinned pi version in
[`docs/pi-api-notes.md`](docs/pi-api-notes.md). `probe/probe.ts` is a standalone
extension that re-checks those API facts against a real pi session.

## Layout

```
core/                     host-free logic (no pi imports)
  config.ts               .pear/config.json, gate arithmetic
  checkpoint.ts           change accounting + file provenance
  git.ts                  porcelain v2 -> file state tokens
  bash.ts                 is this command provably read-only?
  prompts.ts              every string the model or human reads
adapters/pi/
  runtime.ts              session state machine (still host-free)
  extensions/pear.ts      the only pi-specific file
  extensions/checkpoint-card.ts   the TUI card
skills/pear-pairing/      the discipline, as a portable prompt
probe/probe.ts            standalone pi API probe
```

Porting pear to another harness means rewriting `extensions/` — everything else
comes along unchanged.
