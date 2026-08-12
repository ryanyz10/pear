# AGENTS.md

## Project overview

`pear` is a pair-programming loop for the **pi** harness. Either party can hold
the keyboard.

Both start the same way: a **scoping** phase gated by `pear_plan`, where nothing
can be edited until an approach is agreed. After that the `driver` decides what
the **building** phase looks like.

- **`agent-driver`** — the agent builds in digestible increments, punctuated by
  `pear_checkpoint`. At each one you can keep going, have a file walked through,
  change direction, or stop.
- **`human-driver`** — you build; the agent watches the working tree through
  git, nudges when enough has piled up, and eventually starts a turn asking you
  to talk it through. It reads the diff alongside your explanation and says what
  it thinks you got wrong. It cannot edit anything.

`/pear-swap` hands the keyboard over either way, mid-session, keeping the plan.

One review-load budget paces both, so the two never disagree about what "a lot
to read" means.

- Runtime: Node.js **>= 22.19.0** (`.tool-versions` pins the local version).
- Language: TypeScript in native ESM / `NodeNext`, run directly via Node's
  type stripping. Nothing is compiled.
- Package manager: npm. **All dependencies are pinned exactly**; `.npmrc` sets
  `save-exact=true`. Use `npm ci`. Commit `package-lock.json` with any
  dependency change.
- Only host: pi. Other adapters were removed deliberately (see git history).

## Repository layout

- `core/` — host-free logic. **Nothing here may import a host SDK.**
  - `config.ts` — `.pear/config.json` I/O, validation, `loadTier`. Every setting
  is one entry in `CONFIG_SPECS`, which `loadConfig`, `saveConfig` and
  `/pear-config` all read: adding a key anywhere else is a bug.
  - `load.ts` — pricing a tool call, or a working tree, in review-load points
  - `watch.ts` — the human-driver scheduler (debounce, tiers, parking)
  - `checkpoint.ts` — review-load accounting, file-state provenance
  - `git.ts` — porcelain-v2 state tokens, line stats, and the review diff
  - `bash.ts` — "is this command provably read-only?"
  - `prompts.ts` — every string the model or human reads
- `adapters/pi/runtime.ts` — session state machine (phases, holds, accounting).
  Still host-free and fully injectable; the pi extension is a thin wiring layer
  over it.
- `adapters/pi/cards/` — the TUI cards and their dialog fallback. A card is
  **data** (`CardSpec`); `card.ts` renders it in a terminal and `dialogs.ts`
  renders the same spec through `ui.select`/`ui.input`, so the two cannot drift.
  Lives outside `extensions/` on purpose (see invariant below).
- `adapters/pi/extensions/` — the only pi-specific code. **Only files meant to
  be loaded as extensions may live here** (see invariant below).
- `skills/pear-pairing/` — the same discipline as a portable prompt.
- `probe/probe.ts` — standalone API probe, not part of the extension.
- `docs/pi-api-notes.md` — verified pi API facts. **Read this before changing
  anything that touches the host.**

## Commands

```sh
npm ci
npm test
npm run typecheck
npm run smoke:pi
```

Focused runs:

```sh
node --experimental-strip-types --test test/runtime.test.ts
node --experimental-strip-types --test test/pi-lifecycle.test.ts
```

Run `npm test && npm run typecheck` before handing off any change.

There is no formatter or linter. Match the surrounding file's style: double
quotes, semicolons, trailing commas in multiline constructs.

## TypeScript conventions

- `.ts` everywhere, explicit `.ts` extensions on local imports.
- `tsconfig.json` is strict with `erasableSyntaxOnly` and `noEmit`. **No enums,
  parameter properties, or namespaces** — they break Node's type stripping.
- Node's type stripper also rejects `a ?? b && c`; parenthesise explicitly.
- `import type` for type-only imports.
- Validate `unknown` at boundaries rather than casting through it.
- Keep pure policy in small exported functions so it can be tested without I/O.

## Invariants

Violating any of these is a bug even if the tests pass.

### Never abort the agent run

`ctx.abort()` must not appear in pear. The previous implementation called it
when blocking a tool call, which killed the run before the model could see the
block reason — that is the "checkpoints terminate the session" bug this rewrite
exists to fix. Blocking is expressed **only** by returning
`{ block: true, reason }` from `tool_call`. A test asserts there are zero call
sites.

### Hooks decide synchronously; tools may wait

A `tool_call` handler must never await a human. It computes a decision and
returns. Waiting for a person happens inside `pear_checkpoint.execute`, which
is allowed to take as long as it takes.

### Only loadable extensions live in `extensions/`

pi loads *every* file in a directory listed under the manifest's
`"pi".extensions` key. A helper without a default export sitting there is a
load error waiting to happen, so cards, the runtime, and anything else shared
live one level up in `adapters/pi/`.

### The loop can always be unwedged

`pear_ask` and `pear_checkpoint` are never gated and never counted, and
`/pear-checkpoint` opens the same card without the model's involvement. Any
change that could make opening a checkpoint fail because of checkpoint state is
wrong.

### No card answer parks the agent

Every option on every card resolves its tool immediately. "Walk me through a
file" is an *answer*, not a pause: it returns an instruction and relies on the
agent calling `pear_checkpoint` again. Holding a tool open while a human reads
is the failure this design exists to avoid — the agent cannot answer questions
while it is parked inside `execute`.

### The gate is admit-first

`tool_call` compares the load accrued **before** the call it is considering,
then admits. A call is never blocked on its own estimated cost, so a single
oversized change always runs and the block lands on the next one. Blocking the
first write of a window would force a checkpoint with nothing to review.

### The tool-result override appends, never replaces

`ToolResultEventResult.content` **replaces** what the model sees. The budget nag
must return `[...event.content, note]`. Dropping the original blinds the model
to its own tool output.

### `setActiveTools` restores what was observed

Scoping removes `edit` and `write`. Restoring adds back exactly the names pear
removed, on top of whatever is active now — never a hardcoded list and never a
stale snapshot. Another extension may legitimately have changed the tool set
while pear was scoping.

### Accounting errs toward more oversight

- Admitted and priced on `tool_call`, settled on `tool_result`, exactly once.
- A failed call frees its cost; a call that never reports back becomes `stale`
  and **still counts**. Never promote an unknown result to "confirmed success".
- The window total is **recomputed** from surviving entries, never accumulated.
  That is what makes a released file charge correct without refcounting, and
  what makes the total independent of admission order.
- Sweeping happens on `agent_settled` only — `agent_end` can be followed by
  retries or queued continuations.
- Reused call ids **fail closed**: the older entry is settled before the new one
  is admitted, so a cost is never silently lost.

### `agent_settled`, not `agent_end`

Anything that must happen once per settled run hangs off `agent_settled`.

### Only real user input clears a stop

`InputEvent.source` distinguishes `"extension"` (i.e. `sendUserMessage`) from
`"interactive"`/`"rpc"`. Only the latter clears the stop latch, so another
extension cannot override the human. No agent lifecycle event ever clears it.

### One source of truth for the running mode

`runtime.mode` is the mode the session is actually running. It can differ from
what is on disk (headless fail-closed, or a mode saved for later). Do not mirror
it in a second variable in the extension — that copy will drift.

### `ctx.mode`, not `hasUI`, gates the card

`hasUI` is true in RPC too, where `ui.custom` silently no-ops. The full card
requires `ctx.mode === "tui"`; RPC uses dialogs; print/json fail closed to
`off`. **pear never auto-approves a checkpoint.**

### Acknowledgement semantics

`continue`, `steer`, and an approved plan re-baseline (the human saw the
git-verified list before answering). `explain`, `dismissed`, and a failed
checkpoint do **not** — unreviewed files must still appear next time.
`mode-off` neither acknowledges nor stops.

Stop and dismiss are different holds. **Stop** latches until real user input.
**Dismiss** is run-scoped and expires at `agent_settled`, because the human
never said stop — they just walked away. Neither ends the session.

### Git may drive the human-driver trigger, never the agent-driver gate

Agent-driver prices changes from tool inputs and never reads git, so a wrong or
missing file list can only produce a worse-looking card. Human-driver has no
tool calls to price and git is its only witness, so it does depend on
`core/git.ts` — bounded the other way: a git failure means **no trigger**, never
a nag and never a block, and the watcher parks rather than retrying.

### The agent never edits in human-driver

Write tools are suppressed and mutating `bash` is blocked by the hook, in both
phases. This is not only discipline: it means anything appearing in the working
tree is the human's by construction, which is what makes change attribution
unnecessary. Attribution by timestamp or by `isIdle()` is racy at turn
boundaries; not needing it at all is not.

### The watcher parks after repeated failure

`MAX_POLL_FAILURES` consecutive git errors stop the poll, report **once**, and
wait for a restart. The predecessor to `core/watch.ts` retried forever with no
backoff and produced 106 KB of identical log lines from a single
misconfiguration. Sample and measure failures are counted separately, because a
healthy sample would otherwise keep wiping a persistently broken measure.

### Background resources start in `session_start`, never in the factory

pi documents this (`extensions.md:220`): a factory can run in an invocation that
never opens a session. Clear them in `session_shutdown`. Session switches
re-fire both, so the watcher self-heals rather than stacking.

### Acknowledgement means the *reviewing* party saw the changes

In agent-driver that is the human, so `continue`/`steer` re-baseline and
`dismissed` does not. In human-driver the agent is the navigator, so the
baseline moves once it has been shown the diff — **including when the human
replied "not now"**. Erring toward oversight pulls the wrong way here and would
re-quiz someone about work already discussed.

### The human-driver measurement is gross; the pacing is net

`changedLineStats` prices the working tree against `HEAD`, and a human driver
rarely commits between reviews — so the work just explained is still in the
tree. `core/watch.ts` therefore credits `acknowledgedPoints` at acknowledgement
and tiers on `gross - credit`; otherwise the two keystrokes after explaining a
400-line change re-price all 402 and ask again. The credit is dropped whenever
the gross measurement falls below it, because that means a commit or a revert
and a stale credit would mute the watcher permanently.

The counts *shown* stay gross, because the diff handed to the agent is also the
whole uncommitted tree. `/pear-explain` measures outside the watcher, so it must
call `watcher.observe(points)` or its acknowledgement credits nothing.

### An undeliverable trigger must be re-armed, not dropped

The watcher sits on `triggered` until acknowledged, so it does not nag someone
who is deliberately ignoring it. But the auto-trigger declines when the agent is
mid-turn or the human is part-way through a message — and a declined trigger has
nobody to answer it. `pear.ts` calls `watcher.rearm()` whenever `startQuiz`
returns false; without it the watcher goes silent for the rest of the session.
`rearm` deliberately does *not* acknowledge: nothing was reviewed, so the credit
and the baseline stay put.

A residual, accepted: `acknowledge()` samples its new baseline at settle time,
so edits made *while the agent was replying* land inside it. Their points are
uncredited, but they will only be re-measured on the human's next edit. It
self-heals on any keystroke.

### A quiz spans two agent runs

pear injects a message, the agent asks its question, and *that run settles* —
all before the human has typed a word. So `agent_settled` alone cannot end a
quiz. `runtime.quizAnswered`, set from the `input` hook, is what distinguishes
the question turn from the answer turn; ending on the first would rebaseline
over work nobody discussed and the diff would never be attached. Any test of
this path must emit the settle for the question turn, or it is testing an
ordering that never happens.

### Config is never destroyed

Unknown keys round-trip. Legacy `human-driver` is reported, never rewritten. An
unparseable file is backed up before replacement. Writes are temp-file +
rename. Write failures are surfaced as "not persisted", never swallowed.

### Command classification is two layers, and only one is policy

`core/bash.ts` answers read-only only if **both** hold: the command is simple
enough to tokenize (no expansion, no operators, no redirection, no env prefix,
no path-qualified binary), **and** its leading tokens match the allowlist.

The first layer is not configurable and is not a judgement about programs — it
is what makes the second mean anything. The second layer *is* the user's:
`allowedReadOnlyCommands` is config, entries match as token prefixes, and pear
does not second-guess what is on it. `git diff` and `git show` are in the
defaults deliberately; the pager/textconv risk is documented in the module
header and accepted.

Tokenizing is `shell-quote`'s `parse`. **A successful parse is not a safety
verdict.** It does not treat backticks as operators, and `$` expansion
disappears into an empty string — so both are rejected by scanning the raw
string *before* parsing. Anything structural (pipes, redirects, subshells,
globs, comments) comes back as a non-string element and is rejected wholesale.
A flag naming an output file is refused whatever the list says.

When adding to the defaults: dual-purpose programs stay out (`sort -o`,
`git branch -d`, `xargs`, `find -delete`). When in doubt, mutating.

## Testing

`node:test` + `node:assert/strict`. Temp git repos via `mkdtempSync` + `git init`.

**`core/watch.ts` is race-prone.** Its clock and both git reads are parameters
precisely so every transition can be driven deterministically — add a
fake-timer case for any change to it. `test/pi-lifecycle.test.ts` injects a
clock and timer through the factory's optional second argument, which exists
only for that purpose.

Cover in particular: tier boundaries and admit-first; every resolution path of
the pending-card state machine and their races; phase and driver transitions and
out-of-phase calls; stop-latch provenance; orphaned calls; id reuse;
staged-vs-worktree and rename/delete/symlink/unmerged git states; unreadable
files; config failure paths via the injected `fs` seam (not chmod, which
behaves differently as root); TUI/RPC/headless tiers.

Card content is pure data, so `test/cards.test.ts` asserts on it without a
terminal. Prefer adding a case there over reaching into the renderer.

`test/pi-lifecycle.test.ts` drives the real extension through a fake
`ExtensionAPI` — no pi runtime needed.

## Change workflow

1. Read the relevant module, its tests, and `docs/pi-api-notes.md` if the host
   is involved.
2. Make the smallest change that does the job.
3. Update tests alongside it.
4. `npm test && npm run typecheck`.
5. `npm run smoke:pi` for packaging or lifecycle changes.
6. Re-read your own diff before handing off.

If you change the pinned pi version, re-run the `docs/pi-api-notes.md`
checklist — the exact pin exists so host behaviour cannot drift silently.

## Working with the human

- Say what you intend before changing it.
- Small, reviewable steps beat big ones.
- Honour steering immediately, including mid-task.
- Never claim a command, test, or write happened unless you saw it happen.
- Surface assumptions and gaps in validation explicitly.
