# AGENTS.md

## Project overview

`pear` is a pair-programming loop for the **pi** harness. In `agent-driver`
mode you and the agent agree an approach first (the **scoping** phase, gated by
`pear_plan`), then it builds in digestible increments (the **building** phase,
punctuated by `pear_checkpoint`). At each checkpoint you can keep going, have a
file walked through, change direction, or stop. A review-load budget nags in
band and then blocks, so drift is bounded without the prompt being the only
thing holding the line.

- Runtime: Node.js **>= 22.19.0** (`.tool-versions` pins the local version).
- Language: TypeScript in native ESM / `NodeNext`, run directly via Node's
  type stripping. Nothing is compiled.
- Package manager: npm. **All dependencies are pinned exactly**; `.npmrc` sets
  `save-exact=true`. Use `npm ci`. Commit `package-lock.json` with any
  dependency change.
- Only host: pi. Other adapters were removed deliberately (see git history).

## Repository layout

- `core/` — host-free logic. **Nothing here may import a host SDK.**
  - `config.ts` — `.pear/config.json` I/O, validation, `loadTier`
  - `load.ts` — pricing a tool call in review-load points
  - `checkpoint.ts` — review-load accounting, file-state provenance
  - `git.ts` — `git status --porcelain=v2 -z` → state tokens
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

### The file list is display-only

Nothing in `core/git.ts` feeds the gate. That bound is what keeps the module
simple; do not start gating on it.

### Config is never destroyed

Unknown keys round-trip. Legacy `human-driver` is reported, never rewritten. An
unparseable file is backed up before replacement. Writes are temp-file +
rename. Write failures are surfaced as "not persisted", never swallowed.

### Command classification is reject-unless-trivial

`core/bash.ts` classifies a command read-only only if it has no shell
metacharacters, quotes, or backslashes **and** its verb is allowlisted. Adding
a dual-purpose program to the allowlist is a bug: `git diff`/`show`/`log -p`
are excluded because they can invoke pagers, external diff drivers, and
textconv helpers. When in doubt, mutating.

## Testing

`node:test` + `node:assert/strict`. Temp git repos via `mkdtempSync` + `git init`.

Cover in particular: tier boundaries and admit-first; every resolution path of
the pending-card state machine and their races; phase transitions and
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
