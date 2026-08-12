# 🍐 pear

A pair-programming loop for [pi](https://github.com/earendil-works/pi). You agree
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

**1. Agree the approach.** A session starts in the _scoping_ phase. The agent
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

| Answer                      | What happens                                                   |
| --------------------------- | -------------------------------------------------------------- |
| **Keep going**              | Carry on with what it said was next                            |
| **Walk me through a file…** | It explains that file, makes no edits, and the card comes back |
| **Change direction…**       | Your words replace its plan for what comes next                |
| **Stop here**               | Turn ends, no more changes until you speak                     |
| _Escape_                    | Turn ends, nothing acknowledged, nothing latched — just talk   |

"Walk me through a file" is the one worth knowing about. The agent is never
parked waiting on you, so it can actually answer — it explains, then re-opens
the checkpoint so you still get your options back.

Use `/pear` to throw the plan out and start scoping again.

## When you drive

Set `human-driver` (or run `/pear-swap`) and it goes the other way: you write the
code, and pear watches.

It polls git in the background. When enough has piled up, a quiet line appears
above your prompt — no focus stolen, nothing to dismiss:

```
┌─ pear ───────────────────────────────────┐
│ pear · 3 files, ~140 lines uncommitted   │
│ ready when you are                       │
└──────────────────────────────────────────┘
> _
```

Keep going and eventually it speaks up on its own:

> **pear** — I have 3 uncommitted files — src/sync/client.ts, src/sync/retry.ts,
> test/retry.test.ts (+140/−20). Ask me to walk you through what I did and why.

When you answer, pear attaches the actual diff to your message. The agent reads
both and tells you where they disagree — which is the point. Explaining code out
loud is when you notice it's wrong, and a reader with the diff in hand catches
the cases where what you _think_ you wrote and what you wrote have drifted apart.

`/pear-explain` starts that conversation whenever you want it. **The agent cannot
edit anything while you're driving** — if it wants to change something, it says
so and you decide.

It never interrupts you mid-keystroke: it waits for the tree to go quiet for a
few seconds, and it won't start a turn while you're part-way through typing a
message.

## Modes

| Mode            | Behaviour                                            |
| --------------- | ---------------------------------------------------- |
| `off` (default) | pear does nothing                                    |
| `agent-driver`  | The agent builds; you review at checkpoints          |
| `human-driver`  | You build; the agent watches and asks you to explain |

Mode is per-project, stored in `.pear/config.json`. `/pear-swap` changes who is
driving for this session only, without touching the file.

> An earlier version had a very different `human-driver`: a background LLM
> reviewer that posted findings at you and never asked anything. That one is
> gone. If your config still says `human-driver`, it now runs the mode described
> above.

## Commands

| Command                                        | What it does                                              |
| ---------------------------------------------- | --------------------------------------------------------- |
| `/pear`                                        | Throw out the plan and go back to scoping                 |
| `/pear-plan`                                   | Show the plan you agreed to                               |
| `/pear-status`                                 | Mode, phase, review load, and what's outstanding          |
| `/pear-checkpoint`                             | Open a checkpoint yourself, without waiting for the agent |
| `/pear-swap`                                   | Hand the keyboard over, either way                        |
| `/pear-explain`                                | Talk the agent through what you changed                   |
| `/pear-mode [off\|agent-driver\|human-driver]` | Switch mode                                               |
| `/pear-config`                                 | Every setting, in a picker showing its current value      |
| `/pear-config <key> <value>`                   | Set one setting                                           |
| `/pear-config <n>`                             | Shorthand for `reviewBudget`                              |
| `/pear-exclusive`                              | Turn off tools from other extensions                      |

## How the pacing works

The agent is _asked_ to check in at coherent boundaries, and mostly will. The
prompt is not the enforcement, though.

pear scores how much there is for you to **read** since you last looked, in
review-load points:

|                                                              | Points |
| ------------------------------------------------------------ | ------ |
| Each distinct file touched                                   | 40     |
| Each line in an `edit` hunk (both sides — a diff shows both) | 1      |
| Each line of a `write`                                       | 1      |
| A `bash` command that isn't provably read-only               | 60     |

Against a default budget of 200:

| Load      | Agent driving                       | You driving                         |
| --------- | ----------------------------------- | ----------------------------------- |
| under 100 | nothing                             | nothing                             |
| 100–199   | mentions it on the next tool result | nudge appears                       |
| 200+      | says a checkpoint is due            | nudge firms up                      |
| 400+      | blocks further changes              | starts a turn asking you to explain |

When you're driving there is nothing to block, so the budget's top tier starts a
conversation instead. The score is measured from git rather than from tool
inputs, but it's the same score — one `reviewBudget` paces both.

Git measures against `HEAD`, and you probably won't commit between every
conversation, so pear subtracts what it has already shown the agent. Two lines
after explaining a 400-line change score 2, not 402. Commit, and the credit
resets with the tree.

Counting _review load_ rather than tool calls is the point. Five one-line edits
to one file score 50 and pass in silence; one 400-line `write` scores 440 and
blocks everything after it. A call-counting budget got both of those backwards.

The gate is **admit-first**: it looks at the load accrued _before_ the call it
is considering. A single oversized change always runs, and the block lands on
the next one — blocking the first write of a window would force a checkpoint
with nothing to review yet.

A blocked call **did not run**, and the agent is told so, so it can check in and
re-issue it. `pear_ask`, `pear_checkpoint`, and `/pear-checkpoint` are never
blocked, so an exhausted budget can never wedge the session.

### Tuning it

`/pear-config reviewBudget 300` sets the budget. Lower means more checkpoints.
The default is a starting guess — if a real session checkpoints more often than
feels useful, raise it.

The tiers themselves move too. `softFraction` is where the mention starts (0.5
of the budget) and `blockMultiple` is where changes are refused (2× it). Set
`softFraction` to 0.9 to be left alone until a checkpoint is nearly due, or
`blockMultiple` to 1.2 to be stopped almost as soon as one is.

### What counts as a change

Inspection is free: a command on the `allowedReadOnlyCommands` list is never
priced, never blocked while scoping, and still allowed after you have said stop.
Entries match on leading words, so `git log` covers `git log --oneline -n 5`,
and a shorter entry is a broader permission — `git` alone would allow every
subcommand.

A command has to be simple enough to read before the list is consulted at all:
no expansion (`$…`, backticks), no operators, no redirection, no env prefix, no
path-qualified binary. Quoted arguments are fine — `grep "foo bar" file` reads
as three words, because tokenizing is done by a parser rather than by splitting
on spaces.

The defaults include `git diff` and `git show`. They can invoke a pager, an
external diff driver or a textconv filter, all of which run programs named in
git config — that risk is accepted, because reading the diff is most of what
inspection is _for_, and the config that would exploit it lives in the repo
whose test suite the agent already runs. Take them off the list if you disagree.
The one thing the list cannot permit is a flag that names a file to write
(`--output` anywhere, `-o` for git), since that is the definition of not
read-only.

## What the file list means

The checkpoint shows a **git-derived** list of what actually changed since the
last checkpoint, and separately any file the agent _claims_ it touched that git
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

| pi mode      | Cards                                            | Human-driver nudge                         |
| ------------ | ------------------------------------------------ | ------------------------------------------ |
| TUI          | Full card, inline editor, file sub-select        | Yes                                        |
| RPC          | The same card as select/input dialogs            | No — the turn arrives with no warning shot |
| print / json | pear runs `off` for that session, with a warning | —                                          |

`human-driver` also needs a git repository, since git is how it sees what you
changed. Outside one it runs `off` for the session and says so, leaving your
config alone.

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
  "exclusive": false,
  "statusIcon": false,
  "nudge": true,
  "pollMs": 2000,
  "debounceMs": 8000,
  "maxPollFailures": 5,
  "softFraction": 0.5,
  "blockMultiple": 2,
  "allowedReadOnlyCommands": ["ls", "cat", "grep", "git status", "git diff", "..."]
}
```

Every one of these is settable from `/pear-config`, which shows the current
value of each and validates what you type against the same rules a file write
uses.

| Key                       | Default   | What it does                                                     |
| ------------------------- | --------- | ---------------------------------------------------------------- |
| `mode`                    | `off`     | `off`, `agent-driver`, or `human-driver`                         |
| `reviewBudget`            | 200       | Review points allowed between checkpoints (40–100000)            |
| `planPhase`               | true      | Start in scoping, with editing closed until a plan is approved   |
| `exclusive`               | false     | Turn off tools from other extensions at session start            |
| `statusIcon`              | false     | Show 🍐 instead of the word, in the status line and the nudge    |
| `nudge`                   | true      | Show the passive line above your prompt while you drive          |
| `pollMs`                  | 2000      | How often your working tree is checked (250–60000)               |
| `debounceMs`              | 8000      | How long the tree must be quiet before it is priced (500–600000) |
| `maxPollFailures`         | 5         | Consecutive git errors before pear stops watching                |
| `softFraction`            | 0.5       | Share of the budget at which pear starts mentioning it           |
| `blockMultiple`           | 2         | Multiple of the budget at which changes are refused              |
| `allowedReadOnlyCommands` | see above | Commands that count as inspection rather than change             |

- `planPhase: false` skips scoping and starts building immediately, and is the
  one key that only takes effect on the next session.
- `nudge: false` silences the passive line only. The load is still counted and
  the review turn still happens — turning off the warning shot cannot turn off
  the conversation.
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
_feels_ — is in [`scripts/manual-checklist.md`](scripts/manual-checklist.md).

## Layout

```
core/                     host-free logic (no pi imports)
  config.ts               .pear/config.json, budget tiers
  load.ts                 pricing a tool call or a working tree
  checkpoint.ts           review-load accounting + file provenance
  git.ts                  porcelain v2, line stats, the review diff
  watch.ts                when to nudge you, and when to speak up
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
