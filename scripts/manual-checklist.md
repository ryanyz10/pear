# Manual checklist

`npm test` and `npm run smoke:pi` cover everything that can be checked without
a live model and a real terminal. These cannot be: they need a model that
actually calls tools, and a TTY that can render the card and accept keystrokes.

Run this before shipping a change to the checkpoint loop, the gate, or the card.

## Setup

```sh
cd "$(mktemp -d)" && git init -q && git config user.email t@t && git config user.name t
printf 'export function add(a, b) { return a + b; }\n' > math.js
git add -A && git commit -qm init

pi -e /path/to/pear/adapters/pi/extensions/pear.ts
/pear-mode agent-driver
```

## The three answers

| # | Do this | Expect |
| --- | --- | --- |
| 1 | "Add a subtract function to math.js" | The card appears after the edit, with a summary, `math.js` in the git-derived list, and a next step |
| 2 | Choose **Continue** | Agent proceeds; card closes; no error in the transcript |
| 3 | "Add multiply and divide" → at the card choose **Make changes…**, type `only add multiply, skip divide` | Agent follows the typed instruction and does **not** add divide |
| 4 | At the next card press Enter on an empty editor | Editor stays open; nothing is submitted |
| 5 | "Add a modulo function" → choose **Stop** | Agent stops immediately, makes no further edits, and the turn ends |
| 6 | After Stop, type "what did you change?" | Agent answers normally — **the session is alive** |
| 7 | After Stop but before typing, ask it to edit again in the same turn | Blocked with "the navigator asked you to stop" |

## Dismissal

| # | Do this | Expect |
| --- | --- | --- |
| 8 | At a card, press **Esc** | Card closes; changes are paused |
| 9 | Immediately ask for another edit | Blocked, same as Stop |
| 10 | Type any message | Latch clears; edits work again |
| 11 | At the *next* card, check the file list | Files from the dismissed checkpoint are **still listed** (dismissal acknowledges nothing) |

## The budget

| # | Do this | Expect |
| --- | --- | --- |
| 12 | `/pear-config 2`, then "make five separate small edits to math.js without checkpointing" | Third mutation is blocked with "checkpoint overdue"; the agent checkpoints, then continues |
| 13 | Read the blocked tool result in the transcript | It says NOT EXECUTED — and the agent re-issues it rather than assuming it ran |
| 14 | While over budget, run `git status` via bash | Allowed — read-only commands are never gated |
| 15 | While over budget, run `/pear-checkpoint` yourself | Card opens; answering it clears the budget |

## Truthfulness of the file list

| # | Do this | Expect |
| --- | --- | --- |
| 16 | Ask it to edit two files but mention only one in the summary | The git-derived list shows both; the agent's claim is shown separately |
| 17 | `git add` one file, leave another unstaged, then trigger a checkpoint | Both appear |
| 18 | Delete a file, then checkpoint | The deletion appears |

## Lifecycle

| # | Do this | Expect |
| --- | --- | --- |
| 19 | Open a card, then quit pi (Ctrl-C / `/exit`) | pi exits promptly — no hang waiting on the card |
| 20 | Open a card, then `/reload` | Reload completes; no orphaned card |
| 21 | Open a card, then press Esc to abort the tool | Tool result appears; session usable |
| 22 | Mid-turn, run `/pear-mode off` while a card is open | Card resolves; agent told the mode changed; no further gating |
| 23 | Start a turn, let it edit, then Ctrl-C mid-tool | Next turn: `/pear-status` shows the interrupted call counted as unknown, not as success |

## Non-git

| # | Do this | Expect |
| --- | --- | --- |
| 24 | Repeat setup in a non-git directory | Checkpoints still work; the list is labelled "unverified" and shows only the agent's claim |

## What to watch for throughout

- The session must **never** end because of a checkpoint. If pi exits or the
  turn dies after a block, that is the original bug regressing.
- A blocked call must never look to the model like it succeeded.
- The card must never appear when nobody can answer it.
