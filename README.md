# pear

A pair-programming loop for [pi](https://github.com/badlogic/pi-mono). You agree
an approach together, then the agent drives and you navigate — it works in
digestible increments and checks in between them.

```
──────────────────────────────────────────────
 pear · checkpoint

 Session tokens weren't cleared on logout, so a reused browser session
 could resurrect an old identity. Cleared the store in logout() and
 added a test for the reuse case.

 changed (2)
   src/auth.ts
   test/auth.test.ts

 next: audit the refresh path for the same bug

 › Keep going                looks good
   Walk me through a file…   explain one of these
   Change direction…         do something else instead
   Stop here                 I'm taking over

 ↑↓ move · Enter choose · Esc dismiss (pauses changes)
──────────────────────────────────────────────
```

That is the whole idea: small reviewable steps instead of the agent
disappearing for twenty tool calls and handing you a diff to reverse engineer.

**Escape never kills anything.** Dismissing a checkpoint just ends the turn and
gives you the prompt back. Nothing here can end your session.

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

## The loop

**1. Agree the approach.** A session starts in the *scoping* phase. The agent
can read, search, and run read-only commands, but it cannot edit anything. It
asks you about anything genuinely ambiguous, then proposes a plan:

```
 pear · plan

 Wrap the sync client in a retry so transient 5xx stop killing the job.

   1. Add the retry helper
   2. Wire it into the client
   3. Cover it with a test

 › Looks good          start building
   Change something…   tell them what to adjust
   Keep exploring      not enough to go on yet
```

**2. Build against it.** Once you approve, editing opens and the plan becomes
the shared frame: every checkpoint summary is reported against it. Four answers:

| Answer | What happens |
| --- | --- |
| **Keep going** | Carry on with what it said was next |
| **Walk me through a file…** | It explains that file, makes no edits, and the card comes back |
| **Change direction…** | Your words replace its plan for what comes next |
| **Stop here** | Turn ends, no more changes until you speak |
| *Escape* | Turn ends, nothing acknowledged, nothing latched — just talk |

"Walk me through a file" is the one worth knowing about. The agent is never
parked waiting on you, so it can actually answer — it explains, then re-opens
the checkpoint so you still get your options back.

Use `/pear` to throw the plan out and start scoping again.

## Modes

| Mode | Behaviour |
| --- | --- |
| `off` (default) | pear does nothing |
| `agent-driver` | Scope, then build with checkpoints |

Mode is per-project, stored in `.pear/config.json`.

> An earlier version also had a `human-driver` mode, where a background reviewer
> critiqued *your* uncommitted changes. It is not in this version. If your config
> still says `human-driver`, pear runs `off`, tells you so, and **leaves your
> config file untouched** so nothing is lost.

## Commands

| Command | What it does |
| --- | --- |
| `/pear` | Throw out the plan and go back to scoping |
| `/pear-plan` | Show the plan you agreed to |
| `/pear-status` | Mode, phase, review load, and what's outstanding |
| `/pear-checkpoint` | Open a checkpoint yourself, without waiting for the agent |
| `/pear-mode [off\|agent-driver]` | Switch mode |
| `/pear-config [n]` | Review load allowed between checkpoints (default 200) |
| `/pear-exclusive` | Turn off tools from other extensions |

## How the pacing works

The agent is *asked* to check in at coherent boundaries, and mostly will. The
prompt is not the enforcement, though.

pear scores how much there is for you to **read** since you last looked, in
review-load points:

| | Points |
| --- | --- |
| Each distinct file touched | 40 |
| Each line in an `edit` hunk (both sides — a diff shows both) | 1 |
| Each line of a `write` | 1 |
| A `bash` command that isn't provably read-only | 60 |

Against a default budget of 200, that behaves like this:

| Load | What pear does |
| --- | --- |
| under 100 | nothing |
| 100–199 | mentions it on the agent's next tool result |
| 200+ | says plainly that a checkpoint is due |
| 400+ | blocks further changes until one happens |

Counting *review load* rather than tool calls is the point. Five one-line edits
to one file score 50 and pass in silence; one 400-line `write` scores 440 and
blocks everything after it. A call-counting budget got both of those backwards.

The gate is **admit-first**: it looks at the load accrued *before* the call it
is considering. A single oversized change always runs, and the block lands on
the next one — blocking the first write of a window would force a checkpoint
with nothing to review yet.

A blocked call **did not run**, and the agent is told so, so it can check in and
re-issue it. `pear_ask`, `pear_checkpoint`, and `/pear-checkpoint` are never
blocked, so an exhausted budget can never wedge the session.

### Tuning it

`/pear-config` sets the budget. Lower means more checkpoints. The default is a
starting guess — if a real session checkpoints more often than feels useful,
raise it.

## What the file list means

The checkpoint shows a **git-derived** list of what actually changed since the
last checkpoint, and separately any file the agent *claims* it touched that git
did not corroborate. If the agent under-reports, you see it.

That list is best-effort on purpose. It comes from `git status --porcelain=v2`,
including the index object id, so a staged-only change is visible and a file that
changed twice isn't listed twice. Files that can't be read are reported as
changed rather than assumed clean. Outside a git repo the list is marked
unverified and you see only the agent's claim.

Nothing about this list affects the budget — the budget is priced from tool
inputs. A wrong file list can never wedge or bypass the loop.

## Interactivity

A checkpoint needs a human, so pear only runs where one can answer:

| pi mode | Cards |
| --- | --- |
| TUI | Full card, inline editor, file sub-select |
| RPC | The same card as select/input dialogs |
| print / json | pear runs `off` for that session, with a warning |

pear **never** auto-approves. An abandoned dialog is a dismissal, never a
silent "keep going". If nobody can answer, it doesn't pretend one happened.

## Playing well with other extensions

pear is prescriptive, and other extensions that inject their own workflow will
fight it. If foreign tools are active it says so once at startup. `/pear-exclusive`
(or `"exclusive": true`) disables everything that isn't a pi built-in or a pear
tool for that project.

## Configuration

`.pear/config.json`, per project:

```json
{
  "mode": "agent-driver",
  "reviewBudget": 200,
  "planPhase": true,
  "exclusive": false
}
```

- `reviewBudget` is a whole number from 40 to 100000.
- `planPhase: false` skips scoping and starts building immediately.
- The older `maxChangesPerCheckpoint` key is still read — it is translated into
  points and **left on disk untouched**, so downgrading loses nothing.
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

Behaviour that needs a live model and a terminal — how the cadence actually
*feels* — is in [`scripts/manual-checklist.md`](scripts/manual-checklist.md).

## Layout

```
core/                     host-free logic (no pi imports)
  config.ts               .pear/config.json, budget tiers
  load.ts                 pricing a tool call in review points
  checkpoint.ts           review-load accounting + file provenance
  git.ts                  porcelain v2 -> file state tokens
  bash.ts                 is this command provably read-only?
  prompts.ts              every string the model or human reads
adapters/pi/
  runtime.ts              session state machine (still host-free)
  cards/                  the cards, as data + a TUI and a dialog renderer
  extensions/pear.ts      the only pi-specific file
skills/pear-pairing/      the discipline, as a portable prompt
probe/probe.ts            standalone pi API probe
```

Porting pear to another harness means rewriting `extensions/pear.ts` and the
card renderers — `core/` and `runtime.ts` come along unchanged.
